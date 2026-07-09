import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isLoopControlFile, isSupervisorToolName, SUPERVISOR_TOOL_NAMES } from "./src/constants.ts";
import { summaryReportsFailure, validateCompletionSummary } from "./src/completion.ts";
import { activeLoopState, initialLoopState, lastPersistedLoopState, type LoopState } from "./src/loop-state.ts";
import { textResult } from "./src/tool-result.ts";

const SUPERVISOR_SYSTEM_PROMPT = [
	"You are the active loop supervisor: a control-plane orchestrator, not an executor.",
	"Delegate implementation, file inspection, shell execution, testing, and review work to appropriate workers instead of doing it directly.",
	"Track delegated evidence and decide the next supervisor action.",
].join(" ");

type LoopEventKind = "loop.started" | "loop.paused" | "loop.resumed" | "loop.cleared";

type LoopEventPayload = Record<string, unknown>;

function formatLoopStatus(state: LoopState): string {
	if (state.state === "idle") {
		return `Loop state: ${state.state}`;
	}

	const elapsedSeconds = state.startedAt === undefined ? 0 : Math.floor((Date.now() - state.startedAt) / 1000);
	const tokenBudget = state.maxTokens === undefined ? "" : `\nMax tokens: ${state.maxTokens}`;
	return (
		`Loop state: ${state.state}\n` +
		`Objective: ${state.objective}\n` +
		`Iterations: ${state.iterationsUsed}/${state.maxIterations}\n` +
		`Elapsed: ${elapsedSeconds}s${tokenBudget}`
	);
}

/**
 * Pi extension entrypoint for pi-loop.
 */
export default function piLoop(pi: ExtensionAPI): void {
	let loopState: LoopState = initialLoopState();
	let preLoopTools: string[] = [];
	let guardActive = false;
	const controlFiles = new Map<string, string>();

	function persist(state = loopState) {
		pi.appendEntry("loop-state", state);
	}

	function appendLoopEvent(kind: LoopEventKind, payload: LoopEventPayload = {}) {
		const sequence = (loopState.sequence ?? 0) + 1;
		loopState = { ...loopState, sequence };
		pi.appendEntry("loop-event", {
			schemaVersion: 1,
			runId: loopState.runId,
			sequence,
			timestamp: Date.now(),
			kind,
			payload,
		});
	}

	function installRestrictions(): string | undefined {
		const api = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
		if (typeof api.setActiveTools !== "function") {
			return "setActiveTools is unavailable; refusing to start without enforceable tool restrictions.";
		}

		try {
			preLoopTools = api.getActiveTools?.() ?? preLoopTools;
			api.setActiveTools([...SUPERVISOR_TOOL_NAMES]);
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

	function recoverPersistedLoopState(ctx: ExtensionContext) {
		const recovered = lastPersistedLoopState(ctx);
		if (!recovered) {
			return;
		}

		loopState = recovered;
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

	pi.on("session_start", (_event, ctx) => {
		recoverPersistedLoopState(ctx);
	});

	pi.on("before_agent_start", () => {
		if (loopState.state !== "active") {
			return undefined;
		}

		loopState = { ...loopState, iterationsUsed: (loopState.iterationsUsed ?? 0) + 1 };
		if (loopState.iterationsUsed >= loopState.maxIterations) {
			loopState = { ...loopState, state: "budget_limited" };
			restorePreLoopTools();
			persist();
			return undefined;
		}

		persist();
		return { systemPrompt: SUPERVISOR_SYSTEM_PROMPT };
	});

	pi.on("session_before_compact", () => {
		if (loopState.state !== "idle") {
			persist();
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		recoverPersistedLoopState(ctx);
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
		async execute(_toolCallId, params) {
			if (loopState.state !== "idle") {
				throw new Error("loop_start requires idle loop state; refusing to start a new loop.");
			}

			const error = installRestrictions();
			if (error) {
				throw new Error(error);
			}

			loopState = activeLoopState(params);
			controlFiles.set("objective.md", params.objective);
			appendLoopEvent("loop.started", { objective: params.objective });
			persist();
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
			loopState = { ...loopState, state: "paused" };
			appendLoopEvent("loop.paused", { reason: params.reason });
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

			const error = installRestrictions();
			if (error) {
				throw new Error(error);
			}
			loopState = { ...loopState, state: "active" };
			appendLoopEvent("loop.resumed");
			persist();
			return textResult("Loop supervisor mode resumed.");
		},
	});

	pi.registerTool({
		name: "loop_complete",
		label: "Loop Complete",
		description: "Complete loop supervisor mode after verifying each requirement against evidence.",
		parameters: Type.Object({
			summary: Type.String(),
		}),
		async execute(_toolCallId, params) {
			const summary = params.summary.trim();
			const error = validateCompletionSummary(loopState.requirements, summary);
			if (error) {
				if (summaryReportsFailure(summary)) {
					loopState = { ...loopState, state: "failed" };
					persist();
				}
				throw new Error(error);
			}

			loopState = { ...loopState, state: "complete" };
			restorePreLoopTools();
			persist();
			return textResult("Loop supervisor mode complete.");
		},
	});

	pi.registerTool({
		name: "loop_status",
		label: "Loop Status",
		description: "Show current loop supervisor state.",
		parameters: Type.Object({}),
		async execute() {
			return textResult(formatLoopStatus(loopState));
		},
	});

	pi.registerTool({
		name: "loop_delegate",
		label: "Loop Delegate",
		description: "Record a delegation intent for loop supervisor work.",
		parameters: Type.Object({
			target: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			task: Type.String(),
		}),
		async execute(_toolCallId, params) {
			pi.appendEntry("loop-delegation", params);
			return textResult("Delegation intent recorded.");
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
		async execute(_toolCallId, params) {
			if (!isLoopControlFile(params.file)) {
				throw new Error("Rejected: file is outside the loop-scoped markdown control artifacts.");
			}

			controlFiles.set(params.file, params.content);
			return textResult(`Wrote loop control artifact ${params.file}.`);
		},
	});

	pi.registerTool({
		name: "loop_clear",
		label: "Loop Clear",
		description: "Clear the active loop state and restore the pre-loop tool surface.",
		parameters: Type.Object({}),
		async execute() {
			appendLoopEvent("loop.cleared");
			loopState = initialLoopState();
			restorePreLoopTools();
			persist();
			return textResult("Loop state cleared; idle state restored.");
		},
	});
}
