import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { LOOP_CONTROL_FILES } from "../src/constants.ts";
import piLoop from "../index.ts";

const SUPERVISOR_TOOLS = [
	"loop_start",
	"loop_pause",
	"loop_resume",
	"loop_complete",
	"loop_status",
	"loop_delegate",
	"loop_write",
	"loop_clear",
] as const;

const PRE_LOOP_TOOLS = ["read", "bash", "write", "grep", "find", "ls", "edit"];
const PROHIBITED_BUILT_IN_TOOLS = [...PRE_LOOP_TOOLS];

let harnessRoot = "";
let harnessCwd = "";

before(async () => {
	harnessRoot = await mkdtemp(join(tmpdir(), "pi-loop-harness-test-"));
	harnessCwd = join(harnessRoot, "project");
	await mkdir(harnessCwd);
});

after(async () => {
	await rm(harnessRoot, { recursive: true, force: true });
});

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: MockContext,
	) => Promise<ToolResult>;
};

type ToolResult = {
	content?: Array<{ type: "text"; text: string }>;
	details?: unknown;
	terminate?: boolean;
};

type MockContext = {
	cwd: string;
	hasUI: boolean;
	mode: "tui";
	sessionManager: {
		getEntries: () => unknown[];
	};
	hasPendingMessages: () => boolean;
	abort: () => void;
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
};

function createHarness(options: {
	cwd?: string;
	failAppendEntry?: (customType: string, data: unknown) => boolean;
	failSetActiveTools?: boolean;
	pendingMessages?: boolean;
} = {}) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const setActiveToolsCalls: string[][] = [];
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	let activeTools = [...PRE_LOOP_TOOLS];
	let aborted = false;
	let sessionEntries: unknown[] = [];

	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: Function) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			if (options.failSetActiveTools) {
				throw new Error("setActiveTools unavailable");
			}
			setActiveToolsCalls.push([...names]);
			activeTools = [...names];
		},
		appendEntry(customType: string, data: unknown) {
			if (options.failAppendEntry?.(customType, data)) {
				throw new Error("journal unavailable");
			}
			appendEntries.push({ customType, data });
			sessionEntries.push({ type: "custom", customType, data });
		},
		sendMessage(message: unknown, messageOptions: unknown) {
			sentMessages.push({ message, options: messageOptions });
		},
	};

	const ctx: MockContext = {
		cwd: options.cwd ?? harnessCwd,
		hasUI: false,
		mode: "tui",
		sessionManager: {
			getEntries: () => sessionEntries,
		},
		hasPendingMessages: () => options.pendingMessages ?? false,
		abort: () => {
			aborted = true;
		},
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
			setStatus: () => {},
		},
	};

	return {
		pi,
		ctx,
		tools,
		handlers,
		setActiveToolsCalls,
		appendEntries,
		notifications,
		sentMessages,
		get activeTools() {
			return activeTools;
		},
		get aborted() {
			return aborted;
		},
		setSessionEntries(entries: unknown[]) {
			sessionEntries = entries;
		},
	};
}

async function executeTool(
	harness: ReturnType<typeof createHarness>,
	name: string,
	params: Record<string, unknown>,
): Promise<ToolResult> {
	const tool = harness.tools.get(name);
	assert.ok(tool, `${name} tool should be registered`);
	return tool.execute("test-call", params, undefined, undefined, harness.ctx);
}

function lastLoopState(harness: ReturnType<typeof createHarness>) {
	const entry = harness.appendEntries
		.filter((candidate) => candidate.customType === "loop-state")
		.at(-1);
	assert.ok(entry, "expected loop-state to be persisted");
	return entry.data as {
		state?: string;
		objective?: string;
		maxIterations?: number;
		iterationsUsed?: number;
		runId?: string;
		sequence?: number;
	};
}

function resultText(result: ToolResult): string {
	return result.content?.map((part) => part.text).join("\n") ?? "";
}

type LoopEvent = {
	schemaVersion?: number;
	runId?: unknown;
	sequence?: unknown;
	timestamp?: unknown;
	kind?: unknown;
	payload?: unknown;
};

function loopEvents(harness: ReturnType<typeof createHarness>) {
	return harness.appendEntries
		.filter((entry) => entry.customType === "loop-event")
		.map((entry) => entry.data as LoopEvent);
}

function requiredHandler(
	harness: ReturnType<typeof createHarness>,
	eventName: string,
	message: string,
): Function {
	const [handler] = harness.handlers.get(eventName) ?? [];
	assert.ok(handler, message);
	return handler;
}

function persistedLoopStateEntry(state: "active" | "paused", objective: string) {
	return {
		type: "custom",
		customType: "loop-state",
		data: {
			state,
			objective,
			requirements: [],
			maxIterations: 3,
			iterationsUsed: 0,
		},
	};
}

function sessionCompactEvent() {
	return {
		type: "session_compact",
		reason: "manual",
		willRetry: false,
		fromExtension: false,
		compactionEntry: {},
	};
}

async function assertLoopGuardBlocksTool(
	toolCallGuard: Function,
	harness: ReturnType<typeof createHarness>,
	toolName: string,
	toolCallId = `blocked-${toolName}`,
): Promise<void> {
	const result = await toolCallGuard(
		{ type: "tool_call", toolCallId, toolName, input: {} },
		harness.ctx,
	);
	assert.deepEqual(result, {
		block: true,
		reason: `Loop mode: tool '${toolName}' is not on the supervisor allowlist.`,
	});
}

test("registers the supervisor-only loop tool surface", () => {
	const harness = createHarness();

	piLoop(harness.pi as never);

	assert.deepEqual([...harness.tools.keys()].sort(), [...SUPERVISOR_TOOLS].sort());
});

test("loop_start enters active state, installs the supervisor allowlist, and runtime-blocks prohibited tools", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);

	const startResult = await executeTool(harness, "loop_start", {
		objective: "Implement loop supervisor mode safely",
		maxIterations: 3,
	});

	assert.match(resultText(startResult), /started/i);
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), SUPERVISOR_TOOLS);
	assert.equal(lastLoopState(harness).state, "active");

	const toolCallGuard = requiredHandler(harness, "tool_call", "loop mode must install a tool_call runtime guard");

	await assertLoopGuardBlocksTool(toolCallGuard, harness, "bash", "blocked");

	const allowed = await toolCallGuard(
		{ type: "tool_call", toolCallId: "allowed", toolName: "loop_status", input: {} },
		harness.ctx,
	);
	assert.equal(allowed, undefined);
});

test("active loop tool surface contains only supervisor tools and no prohibited built-ins", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);

	await executeTool(harness, "loop_start", { objective: "Verify restricted active tools" });

	for (const tool of PROHIBITED_BUILT_IN_TOOLS) {
		assert.ok(!harness.activeTools.includes(tool), `${tool} should not be active in loop mode`);
	}
	for (const tool of SUPERVISOR_TOOLS) {
		assert.ok(harness.activeTools.includes(tool), `${tool} should be active in loop mode`);
	}
	assert.equal(harness.activeTools.length, SUPERVISOR_TOOLS.length);
});

test("tool_call guard blocks every prohibited built-in during active loop", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Block prohibited built-ins" });

	const toolCallGuard = requiredHandler(harness, "tool_call", "loop mode must install a tool_call runtime guard");

	for (const toolName of PROHIBITED_BUILT_IN_TOOLS) {
		await assertLoopGuardBlocksTool(toolCallGuard, harness, toolName);
	}
});

test("tool_call guard allows every supervisor tool during active loop", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Allow supervisor tools" });

	const toolCallGuard = requiredHandler(harness, "tool_call", "loop mode must install a tool_call runtime guard");

	for (const toolName of SUPERVISOR_TOOLS) {
		const result = await toolCallGuard(
			{ type: "tool_call", toolCallId: `allowed-${toolName}`, toolName, input: {} },
			harness.ctx,
		);
		assert.equal(result, undefined);
	}
});

test("loop_status reports rich lifecycle details for an active loop", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);

	await executeTool(harness, "loop_start", {
		objective: "Ship rich lifecycle status",
		maxIterations: 3,
		maxTokens: 123,
	});

	const status = await executeTool(harness, "loop_status", {});
	const text = resultText(status);
	assert.match(text, /active/i);
	assert.match(text, /Ship rich lifecycle status/);
	assert.match(text, /0\s*\/\s*3/);
	assert.match(text, /elapsed/i);
	assert.match(text, /123/);
});

test("loop_clear removes active loop state and restores pre-loop tools", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Clear this loop" });

	const cleared = await executeTool(harness, "loop_clear", {});

	assert.match(resultText(cleared), /clear|idle|reset/i);
	assert.equal(lastLoopState(harness).state, "idle");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), PRE_LOOP_TOOLS);
	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);

	const status = await executeTool(harness, "loop_status", {});
	assert.match(resultText(status), /idle/i);
});

test("loop lifecycle transitions append ordered journal events with metadata", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);

	await executeTool(harness, "loop_start", { objective: "Journal lifecycle", maxIterations: 2 });
	await executeTool(harness, "loop_pause", { reason: "verify pause event" });
	await executeTool(harness, "loop_resume", {});

	const events = loopEvents(harness);
	assert.equal(events.length, 3);
	assert.deepEqual(
		events.map((event) => event.kind),
		["loop.started", "loop.paused", "loop.resumed"],
	);

	const [runId] = events.map((event) => event.runId);
	assert.equal(typeof runId, "string");
	assert.ok(runId);
	for (const [index, event] of events.entries()) {
		assert.equal(event.schemaVersion, 1);
		assert.equal(event.runId, runId);
		assert.equal(event.sequence, index + 1);
		assert.equal(typeof event.timestamp, "number");
		assert.ok((event.timestamp as number) > 0);
		assert.equal(typeof event.payload, "object");
		assert.notEqual(event.payload, null);
	}
});

test("loop_start throws instead of entering a degraded loop when tool restrictions cannot be installed", async () => {
	const harness = createHarness({ failSetActiveTools: true });
	piLoop(harness.pi as never);

	await assert.rejects(
		() =>
			executeTool(harness, "loop_start", {
				objective: "Do not start without enforceable tool restrictions",
			}),
		/setActiveTools|tool restriction|refus/i,
	);
	assert.equal(harness.appendEntries.some((entry) => (entry.data as { state?: string })?.state === "active"), false);
	assert.equal(harness.appendEntries.some((entry) => entry.customType === "loop-state"), false);
	assert.equal(harness.appendEntries.some((entry) => entry.customType === "loop-event"), false);
});

test("loop_resume throws when supervisor tool restrictions cannot be reinstalled", async () => {
	const harness = createHarness({ failSetActiveTools: true });
	piLoop(harness.pi as never);
	harness.setSessionEntries([
		persistedLoopStateEntry("paused", "Resume only with enforceable restrictions"),
	]);

	const sessionStart = requiredHandler(harness, "session_start", "loop state must be recoverable on session_start");
	await sessionStart({ type: "session_start", reason: "reload" }, harness.ctx);

	await assert.rejects(
		() => executeTool(harness, "loop_resume", {}),
		/setActiveTools|tool restriction|refus/i,
	);
});

async function withTemporaryCwd(run: (cwd: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-control-test-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	try {
		await run(cwd);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function activeControlDirectory(harness: ReturnType<typeof createHarness>) {
	const runId = lastLoopState(harness).runId;
	if (typeof runId !== "string" || runId.length === 0) {
		assert.fail("active state must persist its run identity");
	}
	return join(harness.ctx.cwd, ".pi", "loop", runId);
}

function assertGuardrailJournaled(
	harness: ReturnType<typeof createHarness>,
	entriesBefore: number,
	expected: { file: string; reason: "disallowed_file" | "symlink_destination" | "unsafe_destination" },
): LoopEvent {
	const appended = harness.appendEntries.slice(entriesBefore);
	assert.equal(appended[0]?.customType, "loop-event", "guardrail event must precede rejection visibility");
	const event = appended[0]?.data as LoopEvent;
	assert.equal(event.kind, "loop.guardrail_violation");
	assert.deepEqual(event.payload, {
		tool: "loop_write",
		file: expected.file,
		reason: expected.reason,
	});
	assert.equal("content" in (event.payload as object), false);
	assert.equal(typeof event.sequence, "number");
	assert.equal(appended[1]?.customType, "loop-state", "guardrail sequence must be snapshotted before rejection");
	assert.equal((appended[1]?.data as { sequence?: unknown }).sequence, event.sequence);
	return event;
}

test("loop_start creates its run control directory and loop_write persists every approved artifact", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Persist the control objective" });

		const controlDir = activeControlDirectory(harness);
		assert.equal(await readFile(join(controlDir, "objective.md"), "utf8"), "Persist the control objective");

		for (const file of LOOP_CONTROL_FILES) {
			const content = `# ${file}\nUTF-8 ✓`;
			await executeTool(harness, "loop_write", { file, content });
			assert.equal(await readFile(join(controlDir, file), "utf8"), content);
		}
	});
});

test("loop_write rejects path and name policy violations without outside mutations and journals them", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Reject unsafe control paths" });
		const outside = join(cwd, "..", "outside.txt");
		await writeFile(outside, "unchanged", "utf8");

		const guardrailSequences: number[] = [];
		for (const file of [outside, "../outside.txt", "notes/plan.md", "arbitrary.md", "plan.txt", "src/index.ts"]) {
			const entriesBefore = harness.appendEntries.length;
			await assert.rejects(() => executeTool(harness, "loop_write", { file, content: "secret content" }));
			assert.equal(await readFile(outside, "utf8"), "unchanged");
			const event = assertGuardrailJournaled(harness, entriesBefore, {
				file,
				reason: "disallowed_file",
			});
			guardrailSequences.push(event.sequence as number);
		}
		for (let index = 1; index < guardrailSequences.length; index += 1) {
			assert.ok(
				guardrailSequences[index]! > guardrailSequences[index - 1]!,
				"successive guardrail event sequences must be strictly monotonic",
			);
		}
	});
});

test("loop_write fails closed when its guardrail journal append fails", async () => {
	await withTemporaryCwd(async (cwd) => {
		let failGuardrailAppend = false;
		const harness = createHarness({
			cwd,
			failAppendEntry: (customType, data) =>
				failGuardrailAppend && customType === "loop-event" && (data as LoopEvent).kind === "loop.guardrail_violation",
		});
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Fail closed on guardrail journal errors" });
		failGuardrailAppend = true;

		await assert.rejects(
			() => executeTool(harness, "loop_write", { file: "src/index.ts", content: "must not write" }),
			/journal unavailable/i,
		);
	});
});

test("loop_write refuses approved destination symlinks without changing their outside target", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Reject symlink escapes" });
		const outside = join(cwd, "outside.md");
		await writeFile(outside, "unchanged", "utf8");
		await mkdir(activeControlDirectory(harness), { recursive: true });
		await symlink(outside, join(activeControlDirectory(harness), "plan.md"));

		const entriesBefore = harness.appendEntries.length;
		await assert.rejects(
			() => executeTool(harness, "loop_write", { file: "plan.md", content: "escaped" }),
			(error: { reason?: unknown }) => {
				assert.equal(error.reason, "symlink_destination");
				return true;
			},
		);
		assert.equal(await readFile(outside, "utf8"), "unchanged");
		assertGuardrailJournaled(harness, entriesBefore, {
			file: "plan.md",
			reason: "symlink_destination",
		});
	});
});

test("loop_write rejects hard-linked approved destinations before mutating their outside target", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Reject hard-link escapes" });
		const outside = join(cwd, "outside.md");
		await writeFile(outside, "unchanged", "utf8");
		await link(outside, join(activeControlDirectory(harness), "plan.md"));
		const entriesBefore = harness.appendEntries.length;

		await assert.rejects(
			() => executeTool(harness, "loop_write", { file: "plan.md", content: "escaped" }),
			(error: { reason?: unknown }) => {
				assert.equal(error.reason, "unsafe_destination");
				return true;
			},
		);
		assert.equal(await readFile(outside, "utf8"), "unchanged");
		assertGuardrailJournaled(harness, entriesBefore, {
			file: "plan.md",
			reason: "unsafe_destination",
		});
	});
});

test("loop_write rejects non-regular approved destinations as unsafe", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Reject non-regular destinations" });
		await mkdir(join(activeControlDirectory(harness), "plan.md"));
		const entriesBefore = harness.appendEntries.length;

		await assert.rejects(
			() => executeTool(harness, "loop_write", { file: "plan.md", content: "escaped" }),
			(error: { reason?: unknown }) => {
				assert.equal(error.reason, "unsafe_destination");
				return true;
			},
		);
		assertGuardrailJournaled(harness, entriesBefore, {
			file: "plan.md",
			reason: "unsafe_destination",
		});
	});
});

test("only generated loop controls are ignored", async () => {
	const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
	assert.match(gitignore, /^\.pi\/loop\/$/m);
	assert.doesNotMatch(gitignore, /^\.pi\/$/m);
});

test("reload and compaction retain the persisted run control directory", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Keep the run directory stable" });
		const controlDir = activeControlDirectory(harness);

		await requiredHandler(harness, "session_start", "reload handler required")({ type: "session_start", reason: "reload" }, harness.ctx);
		await requiredHandler(harness, "session_compact", "compaction handler required")(sessionCompactEvent(), harness.ctx);
		await executeTool(harness, "loop_write", { file: "state.md", content: "recovered state" });

		assert.equal(await readFile(join(controlDir, "state.md"), "utf8"), "recovered state");
	});
});

test("loop_complete rejects empty, contradictory, word-only, and missing evidence before accepting current-run delegation evidence", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", {
		objective: [
			"Implement loop supervisor mode.",
			"Requirements:",
			"1. Starting loop mode installs restricted supervisor tools.",
			"2. Prohibited built-in tools are blocked at runtime.",
		].join("\n"),
	});

	await assert.rejects(
		() => executeTool(harness, "loop_complete", { summary: "" }),
		/empty|summary/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1 is complete with evidence, but Requirement 2 is not complete.",
			}),
		/contradict/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1: verified with delegated evidence from tests/tool-guard.test.ts.",
			}),
		/Requirement 2|missing evidence/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: [
					"Requirement 1: verified. Evidence.",
					"Requirement 2: verified. Evidence.",
				].join("\n"),
			}),
		/missing evidence|Requirement 1/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await executeTool(harness, "loop_delegate", {
		task: "Verify restricted supervisor tools are installed",
	});
	await executeTool(harness, "loop_delegate", {
		task: "Verify the runtime guard blocks prohibited built-ins",
	});
	const delegationEntries = harness.appendEntries.filter((entry) => entry.customType === "loop-delegation");
	assert.equal(
		(delegationEntries.at(-1)?.data as { runId?: unknown }).runId,
		lastLoopState(harness).runId,
		"delegation evidence must be scoped to the active run",
	);
	const complete = await executeTool(harness, "loop_complete", {
		summary: [
			"Requirement 1: verified. Evidence: Verify restricted supervisor tools are installed.",
			"Requirement 2: verified. Evidence: Verify the runtime guard blocks prohibited built-ins.",
		].join("\n"),
	});
	assert.match(resultText(complete), /complete/i);
	assert.equal(lastLoopState(harness).state, "complete");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), PRE_LOOP_TOOLS);
	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
	await requiredHandler(harness, "agent_end", "completed loops retain continuation hook")(
		{ type: "agent_end", messages: [] },
		harness.ctx,
	);
	assert.equal(harness.sentMessages.length, 0);
});

test("loop_complete accepts a cited non-empty current-run control artifact for each requirement", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", {
			objective: "Requirements:\n1. Record the plan.\n2. Record the verification.",
		});
		await executeTool(harness, "loop_write", { file: "plan.md", content: "implemented plan" });
		await executeTool(harness, "loop_write", { file: "evidence.md", content: "verification passed" });

		const complete = await executeTool(harness, "loop_complete", {
			summary: "Requirement 1: Evidence: plan.md.\nRequirement 2: Evidence: evidence.md.",
		});
		assert.match(resultText(complete), /complete/i);
		assert.equal(lastLoopState(harness).state, "complete");
	});
});

test("loop_complete rejects delegation and artifact citations that are not safe current-run evidence", async () => {
	const rejectedSummary = "Requirement 1: verified. Evidence: evidence.md.";

	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Use only current-run evidence" });
		await executeTool(harness, "loop_delegate", { task: "prior-run delegated task" });
		await executeTool(harness, "loop_write", { file: "evidence.md", content: "old evidence" });
		await executeTool(harness, "loop_clear", {});
		await executeTool(harness, "loop_start", { objective: "Use only current-run evidence" });

		await assert.rejects(
			() => executeTool(harness, "loop_complete", { summary: "Requirement 1: prior-run delegated task." }),
			/missing evidence|Requirement 1/i,
		);
		await assert.rejects(() => executeTool(harness, "loop_complete", { summary: rejectedSummary }), /missing evidence|Requirement 1/i);
	});

	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Reject embedded artifact names" });

		await assert.rejects(
			() =>
				executeTool(harness, "loop_complete", {
					summary: "Requirement 1: Evidence: nonexistent-objective.md.",
				}),
			/missing evidence|Requirement 1/i,
			"an approved basename embedded in another filename must not count as evidence",
		);
	});

	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Create an earlier run" });
		const priorRunId = lastLoopState(harness).runId;
		assert.equal(typeof priorRunId, "string");
		await executeTool(harness, "loop_clear", {});
		await executeTool(harness, "loop_start", { objective: "Reject prior-run artifact paths" });
		await executeTool(harness, "loop_write", { file: "evidence.md", content: "current evidence" });

		await assert.rejects(
			() =>
				executeTool(harness, "loop_complete", {
					summary: `Requirement 1: Evidence: .pi/loop/${priorRunId}/evidence.md.`,
				}),
			/missing evidence|Requirement 1/i,
			"a prior-run path must not alias the active run's artifact",
		);
	});

	for (const unsafeArtifact of ["missing", "whitespace", "symlink", "hard-link"] as const) {
		await withTemporaryCwd(async (cwd) => {
			const harness = createHarness({ cwd });
			piLoop(harness.pi as never);
			await executeTool(harness, "loop_start", { objective: "Reject unsafe evidence artifacts" });
			const evidencePath = join(activeControlDirectory(harness), "evidence.md");
			if (unsafeArtifact === "whitespace") {
				await writeFile(evidencePath, " \n\t", "utf8");
			} else if (unsafeArtifact === "symlink") {
				const outside = join(cwd, "outside.md");
				await writeFile(outside, "outside evidence", "utf8");
				await symlink(outside, evidencePath);
			} else if (unsafeArtifact === "hard-link") {
				const outside = join(cwd, "outside.md");
				await writeFile(outside, "outside evidence", "utf8");
				await link(outside, evidencePath);
			}

			await assert.rejects(
				() => executeTool(harness, "loop_complete", { summary: rejectedSummary }),
				/missing evidence|Requirement 1/i,
				`${unsafeArtifact} artifact must not count as completion evidence`,
			);
		});
	}
});

test("agent_end queues one custom continuation for an active loop without pending user input", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Continue coordinating delegated work" });

	const agentEnd = requiredHandler(harness, "agent_end", "active loop mode must install an agent_end continuation hook");
	await agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
	await agentEnd({ type: "agent_end", messages: [] }, harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	const [{ message, options }] = harness.sentMessages as Array<{
		message: { customType?: unknown; content?: unknown };
		options: unknown;
	}>;
	assert.equal(message.customType, "loop-continuation");
	assert.match(String(message.content), /continue|objective|delegate/i);
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
});

test("agent_end suppresses continuation for pending input and every non-active lifecycle state", async () => {
	const pending = createHarness({ pendingMessages: true });
	piLoop(pending.pi as never);
	await executeTool(pending, "loop_start", { objective: "Wait for user input" });
	await requiredHandler(pending, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, pending.ctx);
	assert.equal(pending.sentMessages.length, 0);

	for (const state of ["paused", "complete", "budget_limited", "failed", "idle"] as const) {
		const harness = createHarness();
		piLoop(harness.pi as never);
		await executeTool(harness, "loop_start", { objective: "Suppress terminal continuation", maxIterations: 1 });
		if (state === "paused") {
			await executeTool(harness, "loop_pause", {});
		} else if (state === "complete") {
			await executeTool(harness, "loop_delegate", { task: "Complete the only requirement" });
			await executeTool(harness, "loop_complete", { summary: "Requirement 1: Evidence: Complete the only requirement." });
		} else if (state === "budget_limited") {
			await requiredHandler(harness, "agent_start", "iteration hook required")({ type: "agent_start" }, harness.ctx);
		} else if (state === "failed") {
			await assert.rejects(() => executeTool(harness, "loop_complete", { summary: "Requirement 1 failed." }));
		} else {
			await executeTool(harness, "loop_clear", {});
		}
		await requiredHandler(harness, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, harness.ctx);
		assert.equal(harness.sentMessages.length, 0, `${state} loop must not continue`);
	}
});

test("agent_start resets the continuation guard for exactly one next eligible agent_end", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Reset continuation scheduling" });
	const agentEnd = requiredHandler(harness, "agent_end", "continuation hook required");
	const agentStart = requiredHandler(harness, "agent_start", "iteration hook required");

	await agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
	await agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
	await agentStart({ type: "agent_start" }, harness.ctx);
	await agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
	await agentEnd({ type: "agent_end", messages: [] }, harness.ctx);

	assert.equal(harness.sentMessages.length, 2);
});

test("before_agent_start injects a supervisor control-plane prompt while loop mode is active", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Coordinate implementation through delegated workers" });

	const [beforeAgentStart] = harness.handlers.get("before_agent_start") ?? [];
	assert.ok(beforeAgentStart, "active loop mode must install a before_agent_start prompt hook");

	const result = await beforeAgentStart({ type: "before_agent_start" }, harness.ctx);
	const prompt = result?.systemPrompt;
	assert.equal(typeof prompt, "string");
	assert.match(prompt, /orchestrator|control-plane/i);
	assert.match(prompt, /not an executor/i);
	assert.match(prompt, /delegat[^.]*implementation/i);
	assert.match(prompt, /delegat[^.]*inspection/i);
	assert.match(prompt, /delegat[^.]*shell execution/i);
	assert.match(prompt, /delegat[^.]*testing/i);
	assert.match(prompt, /delegat[^.]*review/i);
});

test("agent_start counts automatic continuations against maxIterations without double-counting ordinary turns", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", {
		objective: "Stop when iteration budget is exhausted",
		maxIterations: 2,
	});

	const beforeAgentStart = requiredHandler(
		harness,
		"before_agent_start",
		"active loop mode must install a prompt hook",
	);
	const agentStart = requiredHandler(harness, "agent_start", "active loop mode must count every agent start");

	await beforeAgentStart({ type: "before_agent_start" }, harness.ctx);
	await agentStart({ type: "agent_start" }, harness.ctx);
	assert.equal(lastLoopState(harness).iterationsUsed, 1);
	assert.equal(lastLoopState(harness).state, "active");

	// Pi follow-ups call agent.continue(), which emits agent_start without before_agent_start.
	await agentStart({ type: "agent_start" }, harness.ctx);

	assert.equal(lastLoopState(harness).iterationsUsed, 2);
	assert.equal(lastLoopState(harness).state, "budget_limited");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), PRE_LOOP_TOOLS);
	await requiredHandler(harness, "agent_end", "budget-limited loops must retain continuation hook")(
		{ type: "agent_end", messages: [] },
		harness.ctx,
	);
	assert.equal(harness.sentMessages.length, 0);
	const status = await executeTool(harness, "loop_status", {});
	assert.match(resultText(status), /budget_limited/);
});

test("loop_complete failure summaries reject, persist failed, restore tools, and permanently stop continuation", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Make failed loop state observable" });

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "The delegated implementation failed. Evidence: npm test is still failing.",
			}),
		/failed|failing|contradict/i,
	);

	assert.equal(lastLoopState(harness).state, "failed");
	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
	const toolCallGuard = requiredHandler(harness, "tool_call", "runtime guard required");
	assert.equal(
		await toolCallGuard({ type: "tool_call", toolCallId: "after-failure", toolName: "bash", input: {} }, harness.ctx),
		undefined,
	);
	await requiredHandler(harness, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, harness.ctx);
	assert.equal(harness.sentMessages.length, 0);
	const status = await executeTool(harness, "loop_status", {});
	assert.match(resultText(status), /failed/);
});

test("pause, resume, and reload recovery expose explicit loop states", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Persist loop state", maxIterations: 1 });

	const paused = await executeTool(harness, "loop_pause", { reason: "user requested pause" });
	assert.match(resultText(paused), /paused/i);
	assert.equal(lastLoopState(harness).state, "paused");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), PRE_LOOP_TOOLS);
	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
	assert.equal(harness.aborted, true);

	const resumed = await executeTool(harness, "loop_resume", {});
	assert.match(resultText(resumed), /resumed/i);
	assert.equal(lastLoopState(harness).state, "active");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), SUPERVISOR_TOOLS);

	const [sessionStart] = harness.handlers.get("session_start") ?? [];
	assert.ok(sessionStart, "loop state must be recoverable on session_start");
	await sessionStart({ type: "session_start", reason: "reload" }, harness.ctx);
	const statusAfterReload = await executeTool(harness, "loop_status", {});
	assert.match(resultText(statusAfterReload), /active/);
});

test("active session reload reinstalls the restricted supervisor tool surface", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	harness.setSessionEntries([
		persistedLoopStateEntry("active", "Recovered active loop"),
	]);

	const sessionStart = requiredHandler(harness, "session_start", "loop state must be recoverable on session_start");
	await sessionStart({ type: "session_start", reason: "reload" }, harness.ctx);

	assert.deepEqual(harness.setActiveToolsCalls.at(-1), SUPERVISOR_TOOLS);
	const statusAfterReload = await executeTool(harness, "loop_status", {});
	assert.match(resultText(statusAfterReload), /active/);
});

test("tool_call guard blocks prohibited tools after session_start recovery of active loop", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	harness.setSessionEntries([
		persistedLoopStateEntry("active", "Recovered active loop"),
	]);

	const sessionStart = requiredHandler(harness, "session_start", "loop state must be recoverable on session_start");
	await sessionStart({ type: "session_start", reason: "reload" }, harness.ctx);

	const toolCallGuard = requiredHandler(harness, "tool_call", "recovered active loop must keep the tool_call runtime guard");
	await assertLoopGuardBlocksTool(toolCallGuard, harness, "bash", "blocked-after-session-start");
});

test("session_before_compact persists a fresh loop-state marker for non-idle loops", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Survive session compaction" });
	const appendCountBeforeCompaction = harness.appendEntries.length;

	const [beforeCompact] = harness.handlers.get("session_before_compact") ?? [];
	assert.ok(beforeCompact, "loop mode must install a session_before_compact hook");
	await beforeCompact(
		{
			type: "session_before_compact",
			reason: "manual",
			willRetry: false,
			branchEntries: [],
			preparation: {},
			signal: new AbortController().signal,
		},
		harness.ctx,
	);

	assert.equal(harness.appendEntries.length, appendCountBeforeCompaction + 1);
	assert.equal(lastLoopState(harness).state, "active");
});

test("session_compact rehydrates active loop state and reinstalls supervisor restrictions", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	harness.setSessionEntries([
		persistedLoopStateEntry("active", "Recovered after compaction"),
	]);

	const sessionCompact = requiredHandler(harness, "session_compact", "loop mode must install a session_compact recovery hook");
	await sessionCompact(sessionCompactEvent(), harness.ctx);

	assert.deepEqual(harness.setActiveToolsCalls.at(-1), SUPERVISOR_TOOLS);
	const statusAfterCompact = await executeTool(harness, "loop_status", {});
	assert.match(resultText(statusAfterCompact), /active/);
});

test("tool_call guard blocks prohibited tools after session_compact recovery of active loop", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	harness.setSessionEntries([
		persistedLoopStateEntry("active", "Recovered after compaction"),
	]);

	const sessionCompact = requiredHandler(harness, "session_compact", "loop mode must install a session_compact recovery hook");
	await sessionCompact(sessionCompactEvent(), harness.ctx);

	const toolCallGuard = requiredHandler(harness, "tool_call", "recovered active loop must keep the tool_call runtime guard");
	await assertLoopGuardBlocksTool(toolCallGuard, harness, "bash", "blocked-after-session-compact");
});

test("loop_start cannot re-enter active loop and corrupt pre-loop tool restoration", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Original loop keeps original tools" });

	await assert.rejects(
		() => executeTool(harness, "loop_start", { objective: "Nested loop must be rejected" }),
		/active|idle|state|refus/i,
	);

	await executeTool(harness, "loop_pause", { reason: "verify original tool surface" });

	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
});

test("active compaction recovery cannot corrupt pre-loop tool restoration", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Recover active loop without losing tools" });

	const sessionCompact = requiredHandler(harness, "session_compact", "loop mode must install a session_compact recovery hook");
	await sessionCompact(sessionCompactEvent(), harness.ctx);

	await assert.rejects(
		() => executeTool(harness, "loop_resume", {}),
		/active|paused|state/i,
	);

	await executeTool(harness, "loop_pause", { reason: "verify restored tool surface" });

	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
});
