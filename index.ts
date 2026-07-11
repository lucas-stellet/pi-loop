import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isSupervisorToolName, SUPERVISOR_TOOL_NAMES } from "./src/constants.ts";
import { ControlFilePolicyError, seedControlFiles, writeControlFile } from "./src/control-files.ts";
import {
	semanticCompletionSequences,
	summaryReportsFailure,
	validateAssessmentProvenance,
	validateCompletionSummary,
	type RequirementAssessmentInput,
} from "./src/completion.ts";
import { createJournal, type JournalEvent } from "./src/journal.ts";
import {
	activeLoopState,
	createChildRunId,
	initialLoopState,
	lastPersistedLoopState,
	type LoopState,
} from "./src/loop-state.ts";
import {
	projectRunContext,
	type ProjectableEvent,
} from "./src/projection.ts";
import { textResult } from "./src/tool-result.ts";
import { createPiDelegateExecutor, type DelegateExecutor } from "./src/delegate-executor.ts";
import { resolveDelegate, type DelegateResolver } from "./src/delegate-registry.ts";

const SUPERVISOR_SYSTEM_PROMPT = [
	"You are the active loop supervisor: a control-plane orchestrator, not an executor.",
	"Delegate implementation, file inspection, shell execution, testing, and review work to appropriate workers instead of doing it directly.",
	"Track delegated evidence and decide the next supervisor action.",
	"Use the projected decision context below; do not scan raw JSONL or full child logs.",
].join(" ");

const LOOP_CONTINUATION_CONTENT =
	"Continue supervising the objective: decide the next action, delegate work, and complete only with evidence.";

const DECISION_CONTEXT_MAX_CHARS = 4000;

type LoopEventKind =
	| "loop.started"
	| "loop.paused"
	| "loop.resumed"
	| "loop.cleared"
	| "loop.completed"
	| "loop.failed"
	| "loop.budget_limited"
	| "loop.guardrail_violation"
	| "loop.iteration"
	| "delegation.updated"
	| "supervisor.assessment";

type LoopEventPayload = Record<string, unknown>;

function toProjectableEvents(events: readonly JournalEvent[]): ProjectableEvent[] {
	const projectable: ProjectableEvent[] = [];
	for (const event of events) {
		if (typeof event.runId !== "string") {
			continue;
		}
		projectable.push({
			schemaVersion: 1,
			runId: event.runId,
			sequence: event.sequence,
			timestamp: event.timestamp,
			kind: event.kind,
			payload: event.payload,
		});
	}
	return projectable;
}

function formatLoopStatus(state: LoopState, projectedContext?: string): string {
	if (state.state === "idle") {
		return `Loop state: ${state.state}`;
	}

	const elapsedSeconds = state.startedAt === undefined ? 0 : Math.floor((Date.now() - state.startedAt) / 1000);
	const tokenBudget = state.maxTokens === undefined ? "" : `\nMax tokens: ${state.maxTokens}`;
	const base =
		`Loop state: ${state.state}\n` +
		`Objective: ${state.objective}\n` +
		`Iterations: ${state.iterationsUsed}/${state.maxIterations}\n` +
		`Elapsed: ${elapsedSeconds}s${tokenBudget}`;
	return projectedContext ? `${base}\n\n${projectedContext}` : base;
}

/**
 * Pi extension entrypoint for pi-loop.
 */
export default function piLoop(
	pi: ExtensionAPI,
	dependencies: { delegateExecutor?: DelegateExecutor; delegateResolver?: DelegateResolver } = {},
): void {
	const delegateExecutor = dependencies.delegateExecutor ?? createPiDelegateExecutor();
	const delegateResolver = dependencies.delegateResolver ?? resolveDelegate;
	let loopState: LoopState = initialLoopState();
	let preLoopTools: string[] = [];
	let guardActive = false;
	let continuationScheduled = false;
	// Mutable cwd so the disk journal can resolve `.pi/loop/<runId>/events.jsonl` per tool/session context.
	let journalCwd = process.cwd();
	// Canonical timeline is on-disk JSONL; Pi loop-event/loop-state entries are the migration mirror.
	const journal = createJournal((customType, data) => pi.appendEntry(customType, data), { cwd: () => journalCwd });

	async function syncJournalRun(state: LoopState, cwd: string) {
		if (state.runId) {
			journalCwd = cwd;
			// Sequence comes from validated JSONL replay; companion snapshot sequence is ignored.
			await journal.startRun(state.runId);
		}
	}

	function persist(state = loopState) {
		journal.updateSnapshot(state);
	}

	/** Append a durable journal fact, then advance in-memory sequence from the journal high-water mark. */
	async function appendLoopEvent(
		kind: LoopEventKind,
		payload: LoopEventPayload = {},
		base: LoopState = loopState,
	) {
		await journal.appendEvent(kind, payload);
		loopState = { ...base, sequence: journal.getSequence() };
	}

	function installRestrictions(): string | undefined {
		const api = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
		if (typeof api.setActiveTools !== "function") {
			return "setActiveTools is unavailable; refusing to start without enforceable tool restrictions.";
		}

		try {
			// Snapshot tools only after setActiveTools succeeds so a failed install cannot corrupt preLoopTools.
			const currentTools = api.getActiveTools?.() ?? preLoopTools;
			api.setActiveTools([...SUPERVISOR_TOOL_NAMES]);
			preLoopTools = currentTools;
			guardActive = true;
			return undefined;
		} catch (error) {
			return `setActiveTools failed; refusing to start without enforceable tool restrictions: ${(error as Error).message}`;
		}
	}

	function restorePreLoopTools() {
		guardActive = false;
		pi.setActiveTools(preLoopTools);
	}

	/** Capture the live tool/guard surface so journal failures can roll back start/resume installs. */
	function captureToolSurface() {
		return {
			activeTools: pi.getActiveTools(),
			preLoopTools,
			guardActive,
		};
	}

	function restoreToolSurface(surface: ReturnType<typeof captureToolSurface>) {
		pi.setActiveTools(surface.activeTools);
		preLoopTools = surface.preLoopTools;
		guardActive = surface.guardActive;
	}

	async function recoverPersistedLoopState(ctx: ExtensionContext) {
		const recovered = lastPersistedLoopState(ctx);
		if (!recovered) {
			return;
		}

		loopState = recovered;
		await syncJournalRun(recovered, ctx.cwd);
		loopState = { ...recovered, sequence: journal.getSequence() };
		guardActive = recovered.state === "active";
		if (guardActive) {
			pi.setActiveTools([...SUPERVISOR_TOOL_NAMES]);
		}
	}

	pi.on("tool_call", (event) => {
		if (!guardActive || isSupervisorToolName(event.toolName)) {
			return undefined;
		}

		return {
			block: true,
			reason: `Loop mode: tool '${event.toolName}' is not on the supervisor allowlist.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await recoverPersistedLoopState(ctx);
	});

	pi.on("agent_start", async () => {
		continuationScheduled = false;
		if (loopState.state !== "active") {
			return;
		}

		const iterationsUsed = loopState.iterationsUsed + 1;
		if (iterationsUsed >= loopState.maxIterations) {
			await appendLoopEvent("loop.budget_limited", { iterationsUsed });
			loopState = { ...loopState, iterationsUsed, state: "budget_limited" };
			restorePreLoopTools();
			persist();
			return;
		}
		loopState = { ...loopState, iterationsUsed };
		await appendLoopEvent("loop.iteration", { used: iterationsUsed });
		persist();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (loopState.state !== "active" || !journal.isHealthy()) {
			return;
		}
		if (ctx.hasPendingMessages() || continuationScheduled) {
			return;
		}

		continuationScheduled = true;
		pi.sendMessage(
			{
				customType: "loop-continuation",
				content: LOOP_CONTINUATION_CONTENT,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("before_agent_start", () => {
		if (loopState.state !== "active" || !loopState.runId) {
			return undefined;
		}

		const { context } = projectRunContext({
			runId: loopState.runId,
			events: toProjectableEvents(journal.getEvents()),
			maxCharacters: DECISION_CONTEXT_MAX_CHARS,
		});
		return {
			systemPrompt: `${SUPERVISOR_SYSTEM_PROMPT}\n\n${context}`,
		};
	});

	pi.on("session_before_compact", () => {
		if (loopState.state !== "idle") {
			persist();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		await recoverPersistedLoopState(ctx);
	});

	pi.registerTool({
		name: "loop_start",
		label: "Loop Start",
		description: "Start loop supervisor mode with restricted supervisor tools.",
		parameters: Type.Object({
			objective: Type.String(),
			maxIterations: Type.Optional(Type.Number()),
			maxTokens: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (loopState.state !== "idle") {
				throw new Error("loop_start requires idle loop state; refusing to start a new loop.");
			}

			const nextLoopState = activeLoopState(params);
			if (!nextLoopState.runId) {
				throw new Error("active loop state is missing run identity");
			}
			await seedControlFiles(ctx.cwd, nextLoopState.runId, params.objective);

			const previousSurface = captureToolSurface();
			const error = installRestrictions();
			if (error) {
				throw new Error(error);
			}
			try {
				// Commit active state only after durable start/init; on failure roll tools/guard back to idle surface.
				await syncJournalRun(nextLoopState, ctx.cwd);
				await appendLoopEvent(
					"loop.started",
					{
						objective: params.objective,
						maxIterations: nextLoopState.maxIterations,
						...(nextLoopState.maxTokens === undefined ? {} : { tokenBudget: nextLoopState.maxTokens }),
					},
					nextLoopState,
				);
				persist();
			} catch (error) {
				restoreToolSurface(previousSurface);
				throw error;
			}
			return textResult("Loop supervisor mode started.");
		},
	});

	pi.registerTool({
		name: "loop_pause",
		label: "Loop Pause",
		description: "Pause loop supervisor mode and restore the pre-loop tool surface.",
		parameters: Type.Object({
			reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await appendLoopEvent("loop.paused", { reason: params.reason });
			loopState = { ...loopState, state: "paused" };
			ctx.abort();
			restorePreLoopTools();
			persist();
			return textResult("Loop supervisor mode paused.");
		},
	});

	pi.registerTool({
		name: "loop_resume",
		label: "Loop Resume",
		description: "Resume loop supervisor mode and reinstall restricted supervisor tools.",
		parameters: Type.Object({}),
		async execute() {
			if (loopState.state !== "paused") {
				throw new Error("loop_resume requires a paused loop state; refusing to resume.");
			}

			const previousState = loopState;
			const previousSurface = captureToolSurface();
			const error = installRestrictions();
			if (error) {
				throw new Error(error);
			}
			try {
				// Keep paused lifecycle until the resumed fact is durable; roll tools/guard back on failure.
				await appendLoopEvent("loop.resumed");
				loopState = { ...loopState, state: "active" };
				persist();
			} catch (error) {
				loopState = previousState;
				restoreToolSurface(previousSurface);
				throw error;
			}
			return textResult("Loop supervisor mode resumed.");
		},
	});

	pi.registerTool({
		name: "loop_complete",
		label: "Loop Complete",
		description:
			"Complete loop supervisor mode after verifying each requirement against evidence. Optional assessments cite projected current-run event sequences.",
		parameters: Type.Object({
			summary: Type.String(),
			assessments: Type.Optional(
				Type.Array(
					Type.Object({
						requirementId: Type.String(),
						verdict: Type.String(),
						eventSequences: Type.Array(Type.Number()),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const summary = params.summary.trim();
			const assessments = (params.assessments ?? []) as RequirementAssessmentInput[];
			const knownEventSequences = semanticCompletionSequences(journal.getEvents(), loopState.runId);

			const summaryError = await validateCompletionSummary(loopState.requirements, summary, {
				cwd: ctx.cwd,
				runId: loopState.runId,
				knownEventSequences,
			});
			const assessmentError =
				assessments.length === 0
					? undefined
					: validateAssessmentProvenance(loopState.requirements, assessments, knownEventSequences);
			const error = summaryError ?? assessmentError;
			if (error) {
				if (summaryReportsFailure(summary)) {
					await appendLoopEvent("loop.failed", { summary });
					loopState = { ...loopState, state: "failed" };
					restorePreLoopTools();
					persist();
				}
				throw new Error(error);
			}

			for (const assessment of assessments) {
				await appendLoopEvent("supervisor.assessment", {
					requirementId: assessment.requirementId,
					verdict: assessment.verdict,
					references: assessment.eventSequences.map((sequence) => ({
						runId: loopState.runId,
						sequence,
					})),
				});
			}

			await appendLoopEvent("loop.completed", { summary });
			loopState = { ...loopState, state: "complete" };
			restorePreLoopTools();
			persist();
			return textResult("Loop supervisor mode complete.");
		},
	});

	pi.registerTool({
		name: "loop_status",
		label: "Loop Status",
		description: "Show current loop supervisor state and projected decision context.",
		parameters: Type.Object({}),
		async execute() {
			if (!loopState.runId || loopState.state === "idle") {
				return textResult(formatLoopStatus(loopState));
			}
			const { context } = projectRunContext({
				runId: loopState.runId,
				events: toProjectableEvents(journal.getEvents()),
				maxCharacters: DECISION_CONTEXT_MAX_CHARS,
			});
			return textResult(formatLoopStatus(loopState, context));
		},
	});

	pi.registerTool({
		name: "loop_delegate",
		label: "Loop Delegate",
		description: "Start a delegated loop supervisor task.",
		parameters: Type.Object({
			name: Type.String(),
			task: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!loopState.runId || loopState.state !== "active") {
				throw new Error("loop_delegate requires an active loop run.");
			}
			const metadata = await delegateResolver(params.name);
			if (!metadata) {
				throw new Error("loop_delegate requires an approved agent name.");
			}
			const childRunId = createChildRunId();
			await appendLoopEvent("delegation.updated", {
				childId: childRunId,
				status: "started",
				artifactRefs: [],
			});
			pi.appendEntry("loop-delegation", { ...params, runId: loopState.runId, childRunId });
			persist();
			try {
				await delegateExecutor.launch({ childRunId, cwd: ctx.cwd, task: params.task, metadata });
			} catch (error) {
				await appendLoopEvent("delegation.updated", {
					childId: childRunId,
					status: "failed",
					artifactRefs: [],
				});
				persist();
				throw error;
			}
			return textResult(`Delegation started: ${childRunId}`, { childRunId });
		},
	});

	pi.registerTool({
		name: "loop_write",
		label: "Loop Write",
		description: "Write loop-scoped markdown control artifacts only.",
		parameters: Type.Object({
			file: Type.String(),
			content: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!loopState.runId) {
				throw new Error("loop_write requires an active loop run.");
			}

			try {
				await writeControlFile(ctx.cwd, loopState.runId, params.file, params.content);
			} catch (error) {
				if (error instanceof ControlFilePolicyError) {
					await appendLoopEvent("loop.guardrail_violation", {
						tool: "loop_write",
						file: params.file,
						reason: error.reason,
					});
					persist();
				}
				throw error;
			}

			return textResult(`Wrote loop control artifact ${params.file}.`);
		},
	});

	pi.registerTool({
		name: "loop_clear",
		label: "Loop Clear",
		description: "Clear the active loop state and restore the pre-loop tool surface.",
		parameters: Type.Object({}),
		async execute() {
			await appendLoopEvent("loop.cleared");
			loopState = initialLoopState();
			restorePreLoopTools();
			persist();
			return textResult("Loop state cleared; idle state restored.");
		},
	});
}
