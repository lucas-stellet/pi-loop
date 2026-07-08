import assert from "node:assert/strict";
import test from "node:test";

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
	abort: () => void;
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
};

function createHarness(options: { failSetActiveTools?: boolean } = {}) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Function[]>();
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
			appendEntries.push({ customType, data });
			sessionEntries.push({ type: "custom", customType, data });
		},
	};

	const ctx: MockContext = {
		cwd: "/tmp/pi-loop-test",
		hasUI: false,
		mode: "tui",
		sessionManager: {
			getEntries: () => sessionEntries,
		},
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

	const [toolCallGuard] = harness.handlers.get("tool_call") ?? [];
	assert.ok(toolCallGuard, "loop mode must install a tool_call runtime guard");

	const blocked = await toolCallGuard(
		{ type: "tool_call", toolCallId: "blocked", toolName: "bash", input: { command: "npm test" } },
		harness.ctx,
	);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Loop mode: tool 'bash' is not on the supervisor allowlist.",
	});

	const allowed = await toolCallGuard(
		{ type: "tool_call", toolCallId: "allowed", toolName: "loop_status", input: {} },
		harness.ctx,
	);
	assert.equal(allowed, undefined);
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
});

test("loop_resume throws when supervisor tool restrictions cannot be reinstalled", async () => {
	const harness = createHarness({ failSetActiveTools: true });
	piLoop(harness.pi as never);

	await assert.rejects(
		() => executeTool(harness, "loop_resume", {}),
		/setActiveTools|tool restriction|refus/i,
	);
});

test("loop_write accepts only loop-scoped markdown control artifacts and throws for rejected paths", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", { objective: "Keep writes scoped to loop control files" });

	const allowed = await executeTool(harness, "loop_write", {
		file: "objective.md",
		content: "# Objective\nKeep loop writes scoped.",
	});
	assert.match(resultText(allowed), /Wrote loop control artifact objective\.md/i);

	await assert.rejects(
		() =>
			executeTool(harness, "loop_write", {
				file: "src/index.ts",
				content: "// supervisor must not edit implementation files",
			}),
		/loop-scoped|control|outside|Rejected/i,
	);
});

test("loop_complete throws for empty, contradictory, and missing-evidence summaries before accepting requirement evidence", async () => {
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

	const complete = await executeTool(harness, "loop_complete", {
		summary: [
			"Requirement 1: verified. Evidence: delegated start-mode test showed restricted supervisor tools installed.",
			"Requirement 2: verified. Evidence: delegated tool-call guard test blocked bash/read/write at runtime.",
		].join("\n"),
	});
	assert.match(resultText(complete), /complete/i);
	assert.equal(lastLoopState(harness).state, "complete");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), PRE_LOOP_TOOLS);
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
	assert.match(prompt, /supervisor|orchestrator|control-plane/i);
	assert.match(prompt, /delegat/i);
});

test("before_agent_start exhausts maxIterations into budget_limited and restores pre-loop tools", async () => {
	const harness = createHarness();
	piLoop(harness.pi as never);
	await executeTool(harness, "loop_start", {
		objective: "Stop when iteration budget is exhausted",
		maxIterations: 2,
	});

	const [beforeAgentStart] = harness.handlers.get("before_agent_start") ?? [];
	assert.ok(beforeAgentStart, "iteration budgeting must run from before_agent_start");

	await beforeAgentStart({ type: "before_agent_start" }, harness.ctx);
	await beforeAgentStart({ type: "before_agent_start" }, harness.ctx);

	assert.equal(lastLoopState(harness).state, "budget_limited");
	assert.deepEqual(harness.setActiveToolsCalls.at(-1), PRE_LOOP_TOOLS);
	const status = await executeTool(harness, "loop_status", {});
	assert.match(resultText(status), /budget_limited/);
});

test("loop_complete failure summaries transition to a failed state observable via loop_status", async () => {
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
		{
			type: "custom",
			customType: "loop-state",
			data: {
				state: "active",
				objective: "Recovered active loop",
				requirements: [],
				maxIterations: 3,
				iterationsUsed: 0,
			},
		},
	]);

	const [sessionStart] = harness.handlers.get("session_start") ?? [];
	assert.ok(sessionStart, "loop state must be recoverable on session_start");
	await sessionStart({ type: "session_start", reason: "reload" }, harness.ctx);

	assert.deepEqual(harness.setActiveToolsCalls.at(-1), SUPERVISOR_TOOLS);
	const statusAfterReload = await executeTool(harness, "loop_status", {});
	assert.match(resultText(statusAfterReload), /active/);
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
		{
			type: "custom",
			customType: "loop-state",
			data: {
				state: "active",
				objective: "Recovered after compaction",
				requirements: [],
				maxIterations: 3,
				iterationsUsed: 0,
			},
		},
	]);

	const [sessionCompact] = harness.handlers.get("session_compact") ?? [];
	assert.ok(sessionCompact, "loop mode must install a session_compact recovery hook");
	await sessionCompact(
		{
			type: "session_compact",
			reason: "manual",
			willRetry: false,
			fromExtension: false,
			compactionEntry: {},
		},
		harness.ctx,
	);

	assert.deepEqual(harness.setActiveToolsCalls.at(-1), SUPERVISOR_TOOLS);
	const statusAfterCompact = await executeTool(harness, "loop_status", {});
	assert.match(resultText(statusAfterCompact), /active/);
});
