import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { LOOP_CONTROL_FILES } from "../src/constants.ts";
import { createChildArtifactStore } from "../src/child-artifacts.ts";
import { validateChildStructuredResult, type ChildStructuredResult } from "../src/child-structured-result.ts";
import { DelegateCancellationError, type DelegateExecutor } from "../src/delegate-executor.ts";
import { resolveDelegate, type DelegateMetadata, type DelegateResolver } from "../src/delegate-registry.ts";
import piLoop from "../index.ts";
import { lastPersistedLoopState } from "../src/loop-state.ts";
import { withFileHandleMethod } from "./helpers.ts";

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

type Schema = {
	properties?: Record<string, Schema>;
	minItems?: number;
};

type RegisteredTool = {
	name: string;
	parameters: {
		required?: readonly string[];
		properties?: Record<string, Schema>;
	};
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
	onAppendEntry?: (customType: string, data: unknown) => void;
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
			options.onAppendEntry?.(customType, data);
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

/** Offline fixture: never spawns a real Pi child during supervisor tests. */
function fixtureDelegateExecutor(): DelegateExecutor {
	return {
		async launch() {
			return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: new Promise<void>(() => {}) };
		},
	};
}

/** Offline fixture that settles immediately so completed-delegation evidence can be published. */
function completedDelegateExecutor(): DelegateExecutor {
	return {
		async launch() {
			return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
		},
	};
}

/** Deterministic approved definition so supervisor tests never read ambient ~/.pi state. */
const CONTROLLED_DELEGATE_METADATA: DelegateMetadata = Object.freeze({
	name: "delegate",
	tools: Object.freeze(["read", "bash"]),
	systemPrompt: "Controlled test delegate",
});

const controlledDelegateResolver: DelegateResolver = async (name) =>
	name === "delegate" ? CONTROLLED_DELEGATE_METADATA : undefined;

function installLoop(
	harness: ReturnType<typeof createHarness>,
	dependencies: {
		delegateExecutor?: DelegateExecutor;
		delegateResolver?: DelegateResolver;
	} = {},
): void {
	piLoop(harness.pi as never, {
		delegateExecutor: dependencies.delegateExecutor ?? fixtureDelegateExecutor(),
		delegateResolver: dependencies.delegateResolver ?? controlledDelegateResolver,
	} as never);
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

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value?: T) => void;
	reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolvePromise = done;
		reject = fail;
	});
	return { promise, resolve: (value) => resolvePromise(value as T), reject };
}

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (condition()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
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

/** Bound elapsed-time wait for a real completed delegation event; never fabricates sequences. */
const COMPLETED_DELEGATION_WAIT_MS = 5_000;

async function completedDelegationSequence(
	harness: ReturnType<typeof createHarness>,
	message: string,
	runId?: string,
): Promise<number> {
	const deadline = Date.now() + COMPLETED_DELEGATION_WAIT_MS;
	while (Date.now() < deadline) {
		const sequence = loopEvents(harness).find((event) =>
			event.kind === "delegation.updated"
			&& (event.payload as { status?: unknown }).status === "completed"
			&& (runId === undefined || event.runId === runId),
		)?.sequence;
		if (typeof sequence === "number") return sequence;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

async function completedAssessment(
	harness: ReturnType<typeof createHarness>,
	task: string,
	verdict = "satisfied",
): Promise<Array<{ requirementId: string; verdict: string; eventSequences: number[] }>> {
	await executeTool(harness, "loop_delegate", { name: "delegate", task });
	const completedSequence = await completedDelegationSequence(
		harness,
		"completed delegation evidence was not published",
		lastLoopState(harness).runId as string,
	);
	return [{ requirementId: "1", verdict, eventSequences: [completedSequence] }];
}

function childRuntimeRefs(childId: string) {
	return [
		`children/${childId}/stdout.bin`,
		`children/${childId}/stderr.bin`,
		`children/${childId}/structured.bin`,
	] as const;
}

function allFieldsStructuredResult(childId: string, artifactRefs: readonly string[]) {
	const result = validateChildStructuredResult({
		summary: "structured summary",
		artifactRefs,
		filesChanged: ["src/a.ts"],
		validations: [{ command: "npm test", outcome: "passed" }],
		review: { verdict: "APPROVE", findings: [] },
		nits: ["minor"],
		blockers: ["blocked"],
		confidence: 0,
		classification: "complete",
	});
	assert.ok(result, `all-fields fixture for ${childId} must validate`);
	return result;
}

/** Deterministic lifecycle prefix for a launched child before structured facts/terminal. */
function childLifecycleEvents(childId: string) {
	return [
		["delegation.updated", { childId, status: "started", artifactRefs: [] }],
		["delegation.updated", { childId, status: "running", artifactRefs: [] }],
	] as const;
}

/** Exact typed kinds produced by `allFieldsStructuredResult` in adapter order. */
const ALL_FIELDS_TYPED_KINDS = [
	"workspace.changed",
	"validation.completed",
	"review.completed",
	"nit.recorded",
	"blocker.raised",
] as const;

/** Exact typed facts produced by `allFieldsStructuredResult` in adapter order. */
function allFieldsTypedFacts(childId: string) {
	return [
		["workspace.changed", { childId, files: ["src/a.ts"] }],
		["validation.completed", { childId, command: "npm test", outcome: "passed" }],
		["review.completed", { childId, verdict: "APPROVE", findings: [] }],
		["nit.recorded", { childId, message: "minor" }],
		["blocker.raised", { childId, message: "blocked" }],
	] as const;
}

/** Enriched completed terminal fields for the all-fields fixture with full runtime refs. */
function allFieldsCompletedTerminal(childId: string, refs: readonly string[] = childRuntimeRefs(childId)) {
	return [
		"delegation.updated",
		{
			childId,
			status: "completed",
			artifactRefs: [...refs],
			summary: "structured summary",
			confidence: 0,
			classification: "complete",
			resultArtifactRefs: [refs[2]!],
		},
	] as const;
}

async function readOriginCanonicalEvents(cwd: string, runId: string): Promise<LoopEvent[]> {
	return (await readFile(join(cwd, ".pi", "loop", runId, "events.jsonl"), "utf8"))
		.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
}

async function childEventsInStores(
	cwd: string,
	runId: string,
	harness: ReturnType<typeof createHarness>,
	childId: string,
): Promise<{ canonical: Array<readonly [unknown, unknown]>; mirror: Array<readonly [unknown, unknown]> }> {
	const childEvents = (events: LoopEvent[]) => events
		.filter((event) => (event.payload as { childId?: unknown }).childId === childId)
		.map((event) => [event.kind, event.payload] as const);
	return {
		canonical: childEvents(await readOriginCanonicalEvents(cwd, runId)),
		mirror: childEvents(loopEvents(harness)),
	};
}

async function assertChildEventsInStores(
	cwd: string,
	runId: string,
	harness: ReturnType<typeof createHarness>,
	childId: string,
	expected: Array<readonly [unknown, unknown]>,
	message: string,
): Promise<void> {
	const stores = await childEventsInStores(cwd, runId, harness, childId);
	assert.deepEqual(stores.canonical, expected, message);
	assert.deepEqual(stores.mirror, expected, message);
}

type OriginRunPublications = {
	canonical: LoopEvent[];
	loopEvents: LoopEvent[];
	loopStates: unknown[];
};

async function originRunPublications(
	cwd: string,
	runId: string,
	harness: ReturnType<typeof createHarness>,
): Promise<OriginRunPublications> {
	const publications = (customType: string) => harness.appendEntries
		.filter((entry) => entry.customType === customType && (entry.data as { runId?: unknown }).runId === runId)
		.map((entry) => JSON.parse(JSON.stringify(entry.data)));
	return {
		canonical: await readOriginCanonicalEvents(cwd, runId),
		loopEvents: publications("loop-event") as LoopEvent[],
		loopStates: publications("loop-state"),
	};
}

function assertPoisonedOriginUnchanged(before: OriginRunPublications, after: OriginRunPublications): void {
	for (const [label, events] of [
		["before.canonical", before.canonical],
		["before.loopEvents", before.loopEvents],
		["after.canonical", after.canonical],
		["after.loopEvents", after.loopEvents],
	] as const) {
		assert.equal(
			events.some((event) => event.kind === "loop.paused"),
			false,
			`${label} must not contain loop.paused`,
		);
	}
	for (const key of ["canonical", "loopEvents", "loopStates"] as const) {
		assert.equal(after[key].length, before[key].length, `${key} count must not change after poisoned probe`);
		assert.deepEqual(after[key], before[key], `${key} content must not change after poisoned probe`);
	}
}

/** Capture full-origin pubs, reject poisoned loop_pause, prove no follower growth/mutation. */
async function assertPoisonedLoopPauseLeavesOriginUnchanged(
	cwd: string,
	runId: string,
	harness: ReturnType<typeof createHarness>,
): Promise<void> {
	const before = await originRunPublications(cwd, runId, harness);
	await assert.rejects(() => executeTool(harness, "loop_pause", {}), /unhealthy/i);
	assertPoisonedOriginUnchanged(before, await originRunPublications(cwd, runId, harness));
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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

test("state recovery preserves the real SessionManager getEntries receiver", () => {
	const sessionManager = {
		fileEntries: [persistedLoopStateEntry("active", "Receiver-sensitive recovery")],
		getEntries() {
			return this.fileEntries;
		},
	};
	const recovered = lastPersistedLoopState({ sessionManager } as never);
	assert.equal(recovered?.objective, "Receiver-sensitive recovery");
});

test("registers the supervisor-only loop tool surface", () => {
	const harness = createHarness();

	installLoop(harness);

	assert.deepEqual([...harness.tools.keys()].sort(), [...SUPERVISOR_TOOLS].sort());
});

test("loop_complete schema requires a non-empty assessments array", () => {
	const harness = createHarness();
	installLoop(harness);

	const complete = harness.tools.get("loop_complete");
	assert.ok(complete, "loop_complete tool should be registered");
	assert.ok(complete.parameters.required?.includes("assessments"));
	assert.equal(complete.parameters.properties?.assessments?.minItems, 1);
});

test("loop_start enters active state, installs the supervisor allowlist, and runtime-blocks prohibited tools", async () => {
	const harness = createHarness();
	installLoop(harness);

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
	installLoop(harness);

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
	installLoop(harness);
	await executeTool(harness, "loop_start", { objective: "Block prohibited built-ins" });

	const toolCallGuard = requiredHandler(harness, "tool_call", "loop mode must install a tool_call runtime guard");

	for (const toolName of PROHIBITED_BUILT_IN_TOOLS) {
		await assertLoopGuardBlocksTool(toolCallGuard, harness, toolName);
	}
});

test("tool_call guard allows every supervisor tool during active loop", async () => {
	const harness = createHarness();
	installLoop(harness);
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
	installLoop(harness);

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
	installLoop(harness);
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
	installLoop(harness);

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

	const jsonl = await readFile(join(harness.ctx.cwd, ".pi", "loop", runId as string, "events.jsonl"), "utf8");
	assert.deepEqual(
		jsonl
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line)),
		events,
		"the runtime JSONL log is canonical and the Pi entries are its mirror",
	);
});

test("loop_start throws instead of entering a degraded loop when tool restrictions cannot be installed", async () => {
	const harness = createHarness({ failSetActiveTools: true });
	installLoop(harness);

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

test("loop_start disk failure rolls back to idle and leaves a later run restorable", async () => {
	await withTemporaryCwd(async (cwd) => {
		let failStartWrite = true;
		await withFileHandleMethod(
			"writeFile",
			(original) =>
				async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
					const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					if (failStartWrite && text.includes('"kind":"loop.started"')) {
						throw new Error("start disk append failed");
					}
					return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
				},
			async () => {
				const harness = createHarness({ cwd });
				installLoop(harness);
				await assert.rejects(() => executeTool(harness, "loop_start", { objective: "Fail closed" }), /start disk append failed/);
				assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
				assert.equal(harness.appendEntries.some((entry) => entry.customType === "loop-state"), false);
				assert.equal(loopEvents(harness).some((event) => event.kind === "loop.started"), false);
				const guard = requiredHandler(harness, "tool_call", "runtime guard required");
				assert.equal(guard({ type: "tool_call", toolCallId: "idle", toolName: "bash", input: {} }, harness.ctx), undefined);
				await requiredHandler(harness, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, harness.ctx);
				assert.equal(harness.sentMessages.length, 0);
				const status = await executeTool(harness, "loop_status", {});
				assert.match(resultText(status), /idle/i);

				failStartWrite = false;
				await executeTool(harness, "loop_start", { objective: "Recover cleanly" });
				await executeTool(harness, "loop_clear", {});
				assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
			},
		);
	});
});

test("loop_resume throws when supervisor tool restrictions cannot be reinstalled", async () => {
	const harness = createHarness({ failSetActiveTools: true });
	installLoop(harness);
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

function persistedEvent(runId: string, sequence: number, kind: string) {
	return { schemaVersion: 1, runId, sequence, timestamp: sequence, kind, payload: {} };
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
		installLoop(harness);
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
		installLoop(harness);
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
		installLoop(harness);
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
		installLoop(harness);
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
		installLoop(harness);
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
		installLoop(harness);
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
		installLoop(harness);
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
	installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
	await executeTool(harness, "loop_start", {
		objective: [
			"Implement loop supervisor mode.",
			"Requirements:",
			"1. Starting loop mode installs restricted supervisor tools.",
			"2. Prohibited built-in tools are blocked at runtime.",
		].join("\n"),
	});
	await executeTool(harness, "loop_delegate", {
		name: "delegate",
		task: "Verify restricted supervisor tools are installed",
	});
	await executeTool(harness, "loop_delegate", {
		name: "delegate",
		task: "Verify the runtime guard blocks prohibited built-ins",
	});
	const completedSequence = await completedDelegationSequence(
		harness,
		"completed delegation evidence was not published",
		lastLoopState(harness).runId as string,
	);
	const assessments = [
		{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequence] },
		{ requirementId: "2", verdict: "satisfied", eventSequences: [completedSequence] },
	];

	await assert.rejects(
		() => executeTool(harness, "loop_complete", { summary: "", assessments }),
		/empty|summary/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1 is complete with evidence, but Requirement 2 is not complete.",
				assessments,
			}),
		/contradict/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1: verified with delegated evidence from tests/tool-guard.test.ts.",
				assessments,
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
				assessments,
			}),
		/missing evidence|Requirement 1/i,
	);
	assert.equal(lastLoopState(harness).state, "active");

	await executeTool(harness, "loop_write", { file: "plan.md", content: "verified" });
	await executeTool(harness, "loop_write", { file: "evidence.md", content: "verified" });
	const delegationEntries = harness.appendEntries.filter((entry) => entry.customType === "loop-delegation");
	assert.equal(
		(delegationEntries.at(-1)?.data as { runId?: unknown }).runId,
		lastLoopState(harness).runId,
		"delegation evidence must be scoped to the active run",
	);
	const complete = await executeTool(harness, "loop_complete", {
		summary: [
			"Requirement 1: verified. Evidence: plan.md.",
			"Requirement 2: verified. Evidence: evidence.md.",
		].join("\n"),
		assessments,
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

async function assertCompletionAssessmentRejection(name: string, params: Record<string, unknown>): Promise<void> {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", { objective: "Requirements:\n1. Verify the feature." });
	await executeTool(harness, "loop_write", { file: "plan.md", content: "verified" });
	const eventsBefore = loopEvents(harness).length;
	const toolChangesBefore = harness.setActiveToolsCalls.length;

	await assert.rejects(
		() => executeTool(harness, "loop_complete", {
			summary: "Requirement 1: verified. Evidence: plan.md.",
			...params,
		}),
		/assessment/i,
		`${name} assessments must be rejected`,
	);
	assert.equal(lastLoopState(harness).state, "active", `${name} rejection must keep the loop active`);
	assert.deepEqual(harness.activeTools, SUPERVISOR_TOOLS);
	assert.equal(harness.setActiveToolsCalls.length, toolChangesBefore, `${name} rejection must not restore tools`);
	await assertLoopGuardBlocksTool(requiredHandler(harness, "tool_call", "runtime guard required"), harness, "bash");
	const terminalEvents = loopEvents(harness).slice(eventsBefore).filter((event) =>
		event.kind === "supervisor.assessment" || event.kind === "loop.completed",
	);
	assert.deepEqual(terminalEvents, [], `${name} rejection must not journal terminal effects`);
}

test("loop_complete rejects omitted assessments without terminal effects", async () => {
	await assertCompletionAssessmentRejection("omitted", {});
});

test("loop_complete rejects empty assessments without terminal effects", async () => {
	await assertCompletionAssessmentRejection("empty", { assessments: [] });
});

async function assertExactAssessmentRejection(
	name: string,
	assessments: Array<{ requirementId: string; verdict: string; eventSequences: number[] }>,
	error: RegExp,
): Promise<void> {
	const harness = createHarness();
	installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
	await executeTool(harness, "loop_start", {
		objective: "Requirements:\n1. Verify the plan.\n2. Verify the evidence.",
	});
	await executeTool(harness, "loop_delegate", { name: "delegate", task: "Verify the requirements" });
	const completedSequence = await completedDelegationSequence(harness, "completed delegation evidence was not published");
	await executeTool(harness, "loop_write", { file: "plan.md", content: "verified" });
	await executeTool(harness, "loop_write", { file: "evidence.md", content: "verified" });
	const eventsBefore = loopEvents(harness).length;
	const toolChangesBefore = harness.setActiveToolsCalls.length;

	await assert.rejects(
		() => executeTool(harness, "loop_complete", {
			summary: "Requirement 1: verified. Evidence: plan.md.\nRequirement 2: verified. Evidence: evidence.md.",
			assessments: assessments.map((assessment) => ({ ...assessment, eventSequences: [completedSequence] })),
		}),
		error,
		`${name} assessments must be rejected`,
	);
	assert.equal(lastLoopState(harness).state, "active", `${name} rejection must keep the loop active`);
	assert.deepEqual(harness.activeTools, SUPERVISOR_TOOLS);
	assert.equal(harness.setActiveToolsCalls.length, toolChangesBefore, `${name} rejection must not restore tools`);
	await assertLoopGuardBlocksTool(requiredHandler(harness, "tool_call", "runtime guard required"), harness, "bash");
	const terminalEvents = loopEvents(harness).slice(eventsBefore).filter((event) =>
		event.kind === "supervisor.assessment" || event.kind === "loop.completed",
	);
	assert.deepEqual(terminalEvents, [], `${name} rejection must not journal terminal effects`);
}

test("loop_complete rejects a valid non-empty subset of requirement assessments", async () => {
	await assertExactAssessmentRejection(
		"missing",
		[{ requirementId: "1", verdict: "satisfied", eventSequences: [] }],
		/Requirement 2.*missing an assessment/i,
	);
});

test("loop_complete rejects duplicate aliases for one requirement assessment", async () => {
	await assertExactAssessmentRejection(
		"duplicate",
		[
			{ requirementId: "1", verdict: "satisfied", eventSequences: [] },
			{ requirementId: "REQ-1", verdict: "satisfied", eventSequences: [] },
			{ requirementId: "2", verdict: "satisfied", eventSequences: [] },
		],
		/Requirement 1.*duplicate assessment/i,
	);
});

test("loop_complete rejects unknown requirement assessments", async () => {
	await assertExactAssessmentRejection(
		"unknown",
		[
			{ requirementId: "1", verdict: "satisfied", eventSequences: [] },
			{ requirementId: "2", verdict: "satisfied", eventSequences: [] },
			{ requirementId: "REQ-99", verdict: "satisfied", eventSequences: [] },
		],
		/unknown requirement assessment/i,
	);
});

test("terminal lifecycle facts mirror only while state and supervisor restrictions remain pre-terminal", async () => {
	const cases: Array<{
		kind: "loop.completed" | "loop.failed" | "loop.budget_limited";
		finish: (harness: ReturnType<typeof createHarness>) => Promise<void>;
		state: "complete" | "failed" | "budget_limited";
	}> = [
		{
			kind: "loop.completed",
			state: "complete",
			async finish(harness) {
				await executeTool(harness, "loop_delegate", { name: "delegate", task: "Complete the requirement" });
				const completedSequence = await completedDelegationSequence(harness, "completed delegation evidence was not published");
				await executeTool(harness, "loop_write", { file: "evidence.md", content: "complete" });
				await executeTool(harness, "loop_complete", {
					summary: "Requirement 1: Evidence: evidence.md.",
					assessments: [{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequence] }],
				});
			},
		},
		{
			kind: "loop.failed",
			state: "failed",
			async finish(harness) {
				const assessments = await completedAssessment(harness, "Record failure evidence", "failed");
				await assert.rejects(() => executeTool(harness, "loop_complete", {
					summary: "Requirement 1 failed.",
					assessments,
				}));
			},
		},
		{
			kind: "loop.budget_limited",
			state: "budget_limited",
			async finish(harness) {
				await requiredHandler(harness, "agent_start", "iteration handler required")({ type: "agent_start" }, harness.ctx);
			},
		},
	];

	for (const terminal of cases) {
		let syncCount = 0;
		let observedMirror = false;
		await withFileHandleMethod(
			"sync",
			(original) =>
				async function sync(this: FileHandle) {
					syncCount += 1;
					return (original as () => Promise<void>).call(this);
				},
			async () => {
				let harness: ReturnType<typeof createHarness>;
				harness = createHarness({
					onAppendEntry(customType, data) {
						if (customType !== "loop-event" || (data as LoopEvent).kind !== terminal.kind) return;
						observedMirror = true;
						assert.ok(syncCount > 0, "terminal record must sync before its mirror");
						assert.equal(lastLoopState(harness).state, "active");
						assert.deepEqual(harness.activeTools, SUPERVISOR_TOOLS);
						const guard = requiredHandler(harness, "tool_call", "runtime guard required");
						assert.deepEqual(guard({ type: "tool_call", toolCallId: "terminal", toolName: "bash", input: {} }, harness.ctx), {
							block: true,
							reason: "Loop mode: tool 'bash' is not on the supervisor allowlist.",
						});
						const event = data as LoopEvent;
						const disk = readFileSync(join(harness.ctx.cwd, ".pi", "loop", event.runId as string, "events.jsonl"), "utf8");
						assert.deepEqual(JSON.parse(disk.trimEnd().split("\n").at(-1)!), event);
					},
				});
				installLoop(harness, terminal.kind === "loop.budget_limited" ? {} : { delegateExecutor: completedDelegateExecutor() });
				await executeTool(harness, "loop_start", { objective: "Terminal fact", maxIterations: 1 });
				await terminal.finish(harness);
				assert.equal(observedMirror, true);
				assert.equal(lastLoopState(harness).state, terminal.state);
				assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
				const diskEvents = await readFile(join(harness.ctx.cwd, ".pi", "loop", loopEvents(harness)[0]!.runId as string, "events.jsonl"), "utf8");
				assert.deepEqual(diskEvents.trimEnd().split("\n").map((line) => JSON.parse(line)), loopEvents(harness));
			},
		);
	}
});

test("recovery uses JSONL high-water over stale exact-run snapshots on start and compaction", async () => {
	for (const eventName of ["session_start", "session_compact"] as const) {
		await withTemporaryCwd(async (cwd) => {
			const runId = `stale-${eventName}`;
			await mkdir(join(cwd, ".pi", "loop", runId), { recursive: true });
			await writeFile(
				join(cwd, ".pi", "loop", runId, "events.jsonl"),
				[1, 2, 3].map((sequence) => JSON.stringify(persistedEvent(runId, sequence, sequence === 1 ? "loop.started" : "loop.resumed"))).join("\n") + "\n",
			);
			const harness = createHarness({ cwd });
			installLoop(harness);
			harness.setSessionEntries([{ type: "custom", customType: "loop-state", data: {
				state: "active", objective: "Recover disk authority", requirements: [], maxIterations: 5,
				iterationsUsed: 0, runId, sequence: 1, startedAt: 1,
			} }]);
			await requiredHandler(harness, eventName, "recovery handler required")(eventName === "session_start" ? { type: eventName } : sessionCompactEvent(), harness.ctx);
			await assert.rejects(() => executeTool(harness, "loop_write", { file: "outside.md", content: "no" }));
			assert.equal(lastLoopState(harness).sequence, 4);
			assert.equal(loopEvents(harness).at(-1)?.sequence, 4);
			const sequences = (await readFile(join(cwd, ".pi", "loop", runId, "events.jsonl"), "utf8"))
				.trimEnd().split("\n").map((line) => JSON.parse(line).sequence);
			assert.deepEqual(sequences, [1, 2, 3, 4]);
		});
	}
});

test("mirror poisoning rejects later publication without snapshots or continuation", async () => {
	await withTemporaryCwd(async (cwd) => {
		let failMirror = false;
		const harness = createHarness({ cwd, failAppendEntry: (type) => failMirror && type === "loop-event" });
		installLoop(harness);
		await executeTool(harness, "loop_start", { objective: "Poison publication" });
		failMirror = true;
		const snapshotsBefore = harness.appendEntries.filter((entry) => entry.customType === "loop-state").length;
		await assert.rejects(() => executeTool(harness, "loop_pause", {}), /journal unavailable/);
		const entriesAfterPoison = harness.appendEntries.length;
		await assert.rejects(() => executeTool(harness, "loop_clear", {}), /unhealthy|journal unavailable/);
		assert.equal(harness.appendEntries.length, entriesAfterPoison);
		assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-state").length, snapshotsBefore);
		await requiredHandler(harness, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, harness.ctx);
		assert.equal(harness.sentMessages.length, 0);
	});
});

test("loop_complete journals each multi-requirement assessment with its canonical evidence before completion", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
		await executeTool(harness, "loop_start", {
			objective: "Requirements:\n1. Record the plan.\n2. Record the verification.",
		});
		const runId = lastLoopState(harness).runId as string;
		await executeTool(harness, "loop_delegate", { name: "delegate", task: "Verify the plan" });
		await executeTool(harness, "loop_delegate", { name: "delegate", task: "Verify the evidence" });
		await waitUntil(
			() => loopEvents(harness).filter((event) => event.kind === "delegation.updated" && (event.payload as { status?: unknown }).status === "completed").length === 2,
			"both completed delegation evidence records were not published",
		);
		const completedSequences = loopEvents(harness)
			.filter((event) => event.kind === "delegation.updated" && (event.payload as { status?: unknown }).status === "completed")
			.map((event) => event.sequence)
			.filter((sequence): sequence is number => typeof sequence === "number");
		assert.equal(completedSequences.length, 2);
		await executeTool(harness, "loop_write", { file: "plan.md", content: "implemented plan" });
		await executeTool(harness, "loop_write", { file: "evidence.md", content: "verification passed" });

		const complete = await executeTool(harness, "loop_complete", {
			summary: "Requirement 1: Evidence: plan.md.\nRequirement 2: Evidence: evidence.md.",
			assessments: [
				{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequences[0]!] },
				{ requirementId: "2", verdict: "satisfied", eventSequences: [completedSequences[1]!] },
			],
		});
		assert.match(resultText(complete), /complete/i);
		assert.equal(lastLoopState(harness).state, "complete");

		const canonicalEvents = await readOriginCanonicalEvents(cwd, runId);
		const assessments = canonicalEvents.filter((event) => event.kind === "supervisor.assessment");
		assert.deepEqual(assessments.map((event) => event.payload), [
			{ requirementId: "1", verdict: "satisfied", references: [{ runId, sequence: completedSequences[0] }] },
			{ requirementId: "2", verdict: "satisfied", references: [{ runId, sequence: completedSequences[1] }] },
		]);
		const completionIndex = canonicalEvents.findIndex((event) => event.kind === "loop.completed");
		assert.equal(canonicalEvents.filter((event) => event.kind === "loop.completed").length, 1);
		assert.ok(assessments.every((event) => canonicalEvents.indexOf(event) < completionIndex));
	});
});

test("loop_complete fails closed when the canonical completion write fails before commit", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
		await executeTool(harness, "loop_start", { objective: "Requirements:\n1. Settle only after journaling." });
		const runId = lastLoopState(harness).runId as string;
		await executeTool(harness, "loop_delegate", { name: "delegate", task: "Produce completion evidence" });
		const completedSequence = await completedDelegationSequence(harness, "completed delegation evidence was not published");
		await waitUntil(
			() => lastLoopState(harness).sequence === completedSequence,
			"completed delegation snapshot was not persisted",
		);
		const snapshotsBefore = harness.appendEntries.filter((entry) => entry.customType === "loop-state").length;
		const toolCallsBefore = harness.setActiveToolsCalls.length;

		await withFileHandleMethod(
			"writeFile",
			(original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
				const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				if (text.includes('"kind":"loop.completed"')) throw new Error("completion disk append failed");
				return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
			},
			async () => {
				await assert.rejects(
					() => executeTool(harness, "loop_complete", {
						summary: `Requirement 1: Evidence: #${completedSequence}.`,
						assessments: [{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequence] }],
					}),
					/completion disk append failed/,
				);
			},
		);

		assert.equal(lastLoopState(harness).state, "active");
		assert.deepEqual(harness.activeTools, SUPERVISOR_TOOLS);
		assert.equal(harness.setActiveToolsCalls.length, toolCallsBefore);
		assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-state").length, snapshotsBefore);
		const status = await executeTool(harness, "loop_status", {});
		assert.match(resultText(status), /active/i);
		const guard = requiredHandler(harness, "tool_call", "runtime guard required");
		assert.deepEqual(guard({ type: "tool_call", toolCallId: "blocked", toolName: "bash", input: {} }, harness.ctx), {
			block: true,
			reason: "Loop mode: tool 'bash' is not on the supervisor allowlist.",
		});
		await requiredHandler(harness, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, harness.ctx);
		assert.equal(harness.sentMessages.length, 0);
		const entriesAfterFailure = harness.appendEntries.length;
		await assert.rejects(() => executeTool(harness, "loop_clear", {}), /unhealthy|completion disk append failed/i);
		assert.equal(harness.appendEntries.length, entriesAfterFailure);
		const canonicalEvents = await readOriginCanonicalEvents(cwd, runId);
		assert.equal(canonicalEvents.some((event) => event.kind === "loop.completed"), false);
		assert.equal(canonicalEvents.filter((event) => event.kind === "supervisor.assessment").length, 1);
	});
});

test("loop_complete rejects delegation and artifact citations that are not safe current-run evidence", async () => {
	const rejectedSummary = "Requirement 1: verified. Evidence: evidence.md.";

	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
		await executeTool(harness, "loop_start", { objective: "Use only current-run evidence" });
		await executeTool(harness, "loop_delegate", { name: "delegate", task: "prior-run delegated task" });
		await executeTool(harness, "loop_write", { file: "evidence.md", content: "old evidence" });
		await executeTool(harness, "loop_clear", {});
		await executeTool(harness, "loop_start", { objective: "Use only current-run evidence" });
		const assessments = await completedAssessment(harness, "Record active-run assessment evidence");

		await assert.rejects(
			() => executeTool(harness, "loop_complete", { summary: "Requirement 1: prior-run delegated task.", assessments }),
			/missing evidence|Requirement 1/i,
		);
		await assert.rejects(() => executeTool(harness, "loop_complete", { summary: rejectedSummary, assessments }), /missing evidence|Requirement 1/i);
	});

	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
		await executeTool(harness, "loop_start", { objective: "Reject embedded artifact names" });
		const assessments = await completedAssessment(harness, "Record assessment evidence");

		await assert.rejects(
			() =>
				executeTool(harness, "loop_complete", {
					summary: "Requirement 1: Evidence: nonexistent-objective.md.",
					assessments,
				}),
			/missing evidence|Requirement 1/i,
			"an approved basename embedded in another filename must not count as evidence",
		);
	});

	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
		await executeTool(harness, "loop_start", { objective: "Create an earlier run" });
		const priorRunId = lastLoopState(harness).runId;
		assert.equal(typeof priorRunId, "string");
		await executeTool(harness, "loop_clear", {});
		await executeTool(harness, "loop_start", { objective: "Reject prior-run artifact paths" });
		await executeTool(harness, "loop_write", { file: "evidence.md", content: "current evidence" });
		const assessments = await completedAssessment(harness, "Record assessment evidence");

		await assert.rejects(
			() =>
				executeTool(harness, "loop_complete", {
					summary: `Requirement 1: Evidence: .pi/loop/${priorRunId}/evidence.md.`,
					assessments,
				}),
			/missing evidence|Requirement 1/i,
			"a prior-run path must not alias the active run's artifact",
		);
	});

	for (const unsafeArtifact of ["missing", "whitespace", "symlink", "hard-link"] as const) {
		await withTemporaryCwd(async (cwd) => {
			const harness = createHarness({ cwd });
			installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
			await executeTool(harness, "loop_start", { objective: "Reject unsafe evidence artifacts" });
			const assessments = await completedAssessment(harness, "Record assessment evidence");
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
				() => executeTool(harness, "loop_complete", { summary: rejectedSummary, assessments }),
				/missing evidence|Requirement 1/i,
				`${unsafeArtifact} artifact must not count as completion evidence`,
			);
		});
	}
});

test("agent_end queues one custom continuation for an active loop without pending user input", async () => {
	const harness = createHarness();
	installLoop(harness);
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
	installLoop(pending);
	await executeTool(pending, "loop_start", { objective: "Wait for user input" });
	await requiredHandler(pending, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, pending.ctx);
	assert.equal(pending.sentMessages.length, 0);

	for (const state of ["paused", "complete", "budget_limited", "failed", "idle"] as const) {
		const harness = createHarness();
		installLoop(harness, ["complete", "failed"].includes(state) ? { delegateExecutor: completedDelegateExecutor() } : {});
		await executeTool(harness, "loop_start", { objective: "Suppress terminal continuation", maxIterations: 1 });
		if (state === "paused") {
			await executeTool(harness, "loop_pause", {});
		} else if (state === "complete") {
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "Complete the only requirement" });
			const completedSequence = await completedDelegationSequence(harness, "completed delegation evidence was not published");
			await executeTool(harness, "loop_write", { file: "evidence.md", content: "complete" });
			await executeTool(harness, "loop_complete", {
				summary: "Requirement 1: Evidence: evidence.md.",
				assessments: [{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequence] }],
			});
		} else if (state === "budget_limited") {
			await requiredHandler(harness, "agent_start", "iteration hook required")({ type: "agent_start" }, harness.ctx);
		} else if (state === "failed") {
			const assessments = await completedAssessment(harness, "Record failure evidence", "failed");
			await assert.rejects(() => executeTool(harness, "loop_complete", {
				summary: "Requirement 1 failed.",
				assessments,
			}));
		} else {
			await executeTool(harness, "loop_clear", {});
		}
		await requiredHandler(harness, "agent_end", "continuation hook required")({ type: "agent_end", messages: [] }, harness.ctx);
		assert.equal(harness.sentMessages.length, 0, `${state} loop must not continue`);
	}
});

test("agent_start resets the continuation guard for exactly one next eligible agent_end", async () => {
	const harness = createHarness();
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
	await executeTool(harness, "loop_start", { objective: "Make failed loop state observable" });
	const assessments = await completedAssessment(harness, "Record failure evidence", "failed");

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "The delegated implementation failed. Evidence: npm test is still failing.",
				assessments,
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

test("loop_resume leaves the paused lifecycle and tool surface intact when its disk append fails", async () => {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", { objective: "Resume transaction" });
	await executeTool(harness, "loop_pause", {});
	const runId = lastLoopState(harness).runId;
	if (typeof runId !== "string") {
		assert.fail("paused loop must retain its run identity");
	}
	const eventsPath = join(harness.ctx.cwd, ".pi", "loop", runId, "events.jsonl");
	await rm(eventsPath);
	await mkdir(eventsPath);
	const snapshotsBefore = harness.appendEntries.filter((entry) => entry.customType === "loop-state").length;

	await assert.rejects(() => executeTool(harness, "loop_resume", {}));
	assert.equal(lastLoopState(harness).state, "paused");
	assert.deepEqual(harness.activeTools, PRE_LOOP_TOOLS);
	assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-state").length, snapshotsBefore);
});

test("pause, resume, and reload recovery expose explicit loop states", async () => {
	const harness = createHarness();
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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
	installLoop(harness);
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

test("loop_delegate rejects an unknown named agent before it journals or publishes a delegation", async () => {
	const harness = createHarness();
	let launches = 0;
	const delegateExecutor: DelegateExecutor = {
		async launch() {
			launches += 1;
			return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
		},
	};
	installLoop(harness, { delegateExecutor });
	await executeTool(harness, "loop_start", { objective: "Delegate only to approved workers" });
	const count = (customType: string) => harness.appendEntries.filter((entry) => entry.customType === customType).length;
	const baseline = {
		events: loopEvents(harness).filter((event) => event.kind === "delegation.updated").length,
		delegations: count("loop-delegation"),
		snapshots: count("loop-state"),
	};

	await assert.rejects(
		() => executeTool(harness, "loop_delegate", { name: "../../unapproved", task: "must not run" }),
		/approved|unknown|agent/i,
	);
	assert.equal(launches, 0);
	assert.equal(loopEvents(harness).filter((event) => event.kind === "delegation.updated").length, baseline.events);
	assert.equal(count("loop-delegation"), baseline.delegations);
	assert.equal(count("loop-state"), baseline.snapshots);
});

test("loop_delegate validates the active loop before resolving a definition", async () => {
	const harness = createHarness();
	let resolutions = 0;
	let launches = 0;
	installLoop(harness, {
		delegateResolver: async () => {
			resolutions += 1;
			return undefined;
		},
		delegateExecutor: {
			async launch() {
				launches += 1;
				return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
			},
		},
	});
	await assert.rejects(
		() => executeTool(harness, "loop_delegate", { name: "delegate", task: "must not resolve" }),
		/active|loop/i,
	);
	assert.equal(resolutions, 0);
	assert.equal(launches, 0);
});

test("loop_delegate rejects a missing controlled definition without publication or launch", async () => {
	const harness = createHarness();
	let launches = 0;
	const delegateExecutor: DelegateExecutor = {
		async launch() {
			launches += 1;
			return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
		},
	};
	installLoop(harness, { delegateExecutor, delegateResolver: async () => undefined });
	await executeTool(harness, "loop_start", { objective: "Reject an absent definition" });
	const count = (customType: string) => harness.appendEntries.filter((entry) => entry.customType === customType).length;
	const baseline = {
		events: loopEvents(harness).filter((event) => event.kind === "delegation.updated").length,
		delegations: count("loop-delegation"),
		snapshots: count("loop-state"),
	};

	await assert.rejects(
		() => executeTool(harness, "loop_delegate", { name: "delegate", task: "must not launch" }),
		/approved|unknown|agent/i,
	);
	assert.equal(launches, 0);
	assert.equal(loopEvents(harness).filter((event) => event.kind === "delegation.updated").length, baseline.events);
	assert.equal(count("loop-delegation"), baseline.delegations);
	assert.equal(count("loop-state"), baseline.snapshots);
});

test("loop_delegate resolves a controlled on-disk definition for its one started launch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-delegate-integration-"));
	try {
		await mkdir(join(root, "agents"));
		await writeFile(
			join(root, "agents", "delegate.md"),
			"---\nname: delegate\ntools: read, bash\n---\nControlled on-disk prompt",
		);
		const harness = createHarness();
		const launches: Array<{ metadata: DelegateMetadata }> = [];
		installLoop(harness, {
			delegateResolver: (name) => resolveDelegate(name, { rootResolver: () => root }),
			delegateExecutor: {
				async launch(request) {
					launches.push(request);
					return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
				},
			},
		});
		await executeTool(harness, "loop_start", { objective: "Use controlled on-disk metadata" });
		const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "controlled task" });

		assert.equal(launches.length, 1);
		assert.deepEqual(launches[0]?.metadata, {
			name: "delegate",
			tools: ["read", "bash"],
			systemPrompt: "Controlled on-disk prompt",
		});
		assert.equal(Object.isFrozen(launches[0]?.metadata), true);
		assert.equal(Object.isFrozen(launches[0]?.metadata.tools), true);
		const details = delegated.details as { childRunId?: unknown } | undefined;
		assert.equal(typeof details?.childRunId, "string");
		assert.deepEqual(loopEvents(harness).filter((event) => event.kind === "delegation.updated")[0]?.payload, {
			childId: details?.childRunId,
			status: "started",
			artifactRefs: [],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("loop_delegate publishes one canonical started association before launching the child", async () => {
	await withTemporaryCwd(async (cwd) => {
		const order: string[] = [];
		let parentRunId = "";
		let startedFromDisk: LoopEvent | undefined;
		let startedMirror: LoopEvent | undefined;
		let legacyDelegation: { runId?: string; childRunId?: string } | undefined;
		let delegationSnapshot: { runId?: string; sequence?: number } | undefined;
		let traceDelegation = false;
		const harness = createHarness({
			cwd,
			onAppendEntry(customType, data) {
				if (!traceDelegation) return;
				if (customType === "loop-event" && (data as LoopEvent).kind === "delegation.updated") {
					const records = readFileSync(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					if (((data as LoopEvent).payload as { status?: unknown }).status === "started") {
						startedFromDisk = records.at(-1);
						startedMirror = data as LoopEvent;
						order.push("canonical JSONL", "started mirror");
					} else {
						order.push("running canonical JSONL", "running mirror");
					}
				}
				if (customType === "loop-delegation") {
					legacyDelegation = data as { runId?: string; childRunId?: string };
					order.push("legacy delegation");
				}
				if (customType === "loop-state" && order.includes("legacy delegation")) {
					delegationSnapshot ??= data as { runId?: string; sequence?: number };
					order.push("delegation snapshot");
				}
			},
		});
		let launchChildId = "";
		installLoop(harness, { delegateExecutor: { async launch(request) {
			launchChildId = request.childRunId;
			order.push("launch");
			return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: new Promise<void>(() => {}) };
		} } });
		await executeTool(harness, "loop_start", { objective: "Publish before launching" });
		parentRunId = lastLoopState(harness).runId as string;
		const count = (type: string) => harness.appendEntries.filter((entry) => entry.customType === type).length;
		const baseline = { mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") };
		order.length = 0;
		startedFromDisk = undefined;
		startedMirror = undefined;
		legacyDelegation = undefined;
		delegationSnapshot = undefined;
		traceDelegation = true;

		const result = await executeTool(harness, "loop_delegate", { name: "delegate", task: "Run one child" });
		order.push("result");
		const childRunId = (result.details as { childRunId: string }).childRunId;

		assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, {
			mirrors: baseline.mirrors + 2,
			legacy: baseline.legacy + 1,
			snapshots: baseline.snapshots + 2,
		});
		assert.deepEqual(order, ["canonical JSONL", "started mirror", "legacy delegation", "delegation snapshot", "launch", "running canonical JSONL", "running mirror", "delegation snapshot", "result"]);
		const recordedStartedFromDisk = startedFromDisk as LoopEvent | undefined;
		const recordedStartedMirror = startedMirror as LoopEvent | undefined;
		const recordedLegacyDelegation = legacyDelegation as { runId?: string; childRunId?: string } | undefined;
		const recordedDelegationSnapshot = delegationSnapshot as { runId?: string; sequence?: number } | undefined;
		for (const event of [recordedStartedFromDisk, recordedStartedMirror]) {
			assert.equal(event?.runId, parentRunId);
			assert.deepEqual(event?.payload, { childId: childRunId, status: "started", artifactRefs: [] });
		}
		assert.equal(recordedLegacyDelegation?.runId, parentRunId);
		assert.equal(recordedLegacyDelegation?.childRunId, childRunId);
		assert.equal(recordedDelegationSnapshot?.runId, parentRunId);
		assert.equal(recordedDelegationSnapshot?.sequence, recordedStartedFromDisk?.sequence);
		assert.equal(launchChildId, childRunId);
		assert.equal((result.details as { childRunId?: string }).childRunId, childRunId);
		assert.match(resultText(result), new RegExp(childRunId));
	});
});

test("loop_delegate suppresses launch and later publications when its started disk append fails", async () => {
	await withTemporaryCwd(async (cwd) => {
		let failStartedWrite = false;
		await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			if (failStartedWrite && text.includes('"kind":"delegation.updated"') && text.includes('"status":"started"')) {
				throw new Error("started disk append failed");
			}
			return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
		}, async () => {
			const launches: unknown[] = [];
			const harness = createHarness({ cwd });
			installLoop(harness, { delegateExecutor: { async launch(request) {
				launches.push(request);
				return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
			} } });
			await executeTool(harness, "loop_start", { objective: "Fail closed before delegation launch" });
			const parentRunId = lastLoopState(harness).runId as string;
			const count = (type: string) => harness.appendEntries.filter((entry) => entry.customType === type).length;
			const baseline = { mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") };
			failStartedWrite = true;

			await assert.rejects(() => executeTool(harness, "loop_delegate", { name: "delegate", task: "must not launch" }), /started disk append failed/);
			assert.equal(launches.length, 0);
			assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, baseline);
			const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
			assert.equal(records.some((event) => event.kind === "delegation.updated"), false);
			await assert.rejects(() => executeTool(harness, "loop_pause", {}), /Loop journal is unhealthy/);
			assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, baseline);
		});
	});
});

test("loop_delegate suppresses launch and later publications when its started mirror fails", async () => {
	await withTemporaryCwd(async (cwd) => {
		let failStartedMirror = false;
		const launches: unknown[] = [];
		const harness = createHarness({ cwd, onAppendEntry(customType, data) {
			const event = data as LoopEvent;
			if (failStartedMirror && customType === "loop-event" && event.kind === "delegation.updated" && (event.payload as { status?: string }).status === "started") {
				throw new Error("started mirror failed");
			}
		} });
		installLoop(harness, { delegateExecutor: { async launch(request) {
			launches.push(request);
			return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
		} } });
		await executeTool(harness, "loop_start", { objective: "Fail closed after canonical delegation append" });
		const parentRunId = lastLoopState(harness).runId as string;
		const count = (type: string) => harness.appendEntries.filter((entry) => entry.customType === type).length;
		const baseline = { mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") };
		failStartedMirror = true;

		await assert.rejects(() => executeTool(harness, "loop_delegate", { name: "delegate", task: "must not launch" }), /started mirror failed/);
		assert.equal(launches.length, 0);
		assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, baseline);
		const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
		const started = records.filter((event) => event.kind === "delegation.updated");
		assert.equal(started.length, 1);
		assert.equal(started[0]?.runId, parentRunId);
		const retainedChildId = (started[0]?.payload as { childId?: unknown }).childId;
		assert.equal(typeof retainedChildId, "string");
		assert.notEqual(retainedChildId, "");
		assert.match(retainedChildId as string, /^child-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.deepEqual(started[0]?.payload, { childId: retainedChildId, status: "started", artifactRefs: [] });
		await assert.rejects(() => executeTool(harness, "loop_pause", {}), /Loop journal is unhealthy/);
		assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, baseline);
	});
});

test("loop_delegate prefers terminal journal failures over the executor rejection", async () => {
	const cases = [
		{ name: "canonical write", error: new Error("unique failed canonical write error"), stage: "write" },
		{ name: "settlement sync", error: new Error("unique failed settlement sync error"), stage: "sync" },
		{ name: "loop-event mirror", error: new Error("unique failed loop-event mirror error"), stage: "mirror" },
	] as const;

	for (const row of cases) {
		await withTemporaryCwd(async (cwd) => {
			const executorError = new Error(`unique executor rejection: ${row.name}`);
			let terminalPhase = false;
			let failedWriteAttempts = 0;
			let failedSyncAttempts = 0;
			let failedSyncCompleted = false;
			let failedMirrorAttempts = 0;
			let failureStageObserved = false;
			let callerCaughtAfterFailure = false;
			let executorCalls = 0;
			let launchedChildId = "";
			let parentRunId = "";
			let baseline!: { mirrors: number; legacy: number; snapshots: number };
			const harness = createHarness({
				cwd,
				onAppendEntry(customType, data) {
					const event = data as LoopEvent;
					if (terminalPhase && customType === "loop-event" && event.kind === "delegation.updated" && (event.payload as { status?: unknown }).status === "failed") {
						failedMirrorAttempts += 1;
						if (row.stage === "mirror") {
							failureStageObserved = true;
							throw row.error;
						}
					}
				},
			});
			const count = (type: string) => harness.appendEntries.filter((entry) => entry.customType === type).length;
			installLoop(harness, {
				delegateExecutor: {
					async launch(request) {
						executorCalls += 1;
						launchedChildId = request.childRunId;
						baseline = { mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") };
						terminalPhase = true;
						throw executorError;
					},
				},
			});

			await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
				const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				const failedEvent = terminalPhase && text.includes('"kind":"delegation.updated"') && text.includes('"status":"failed"');
				if (failedEvent) {
					failedWriteAttempts += 1;
					if (row.stage === "write") {
						failureStageObserved = true;
						throw row.error;
					}
				}
				return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
			}, async () => {
				await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
					if (terminalPhase) {
						failedSyncAttempts += 1;
						if (row.stage === "sync") {
							failureStageObserved = true;
							throw row.error;
						}
						await (original as () => Promise<void>).call(this);
						failedSyncCompleted = true;
						return;
					}
					return (original as () => Promise<void>).call(this);
				}, async () => {
					await executeTool(harness, "loop_start", { objective: `Prefer ${row.name} failure` });
					parentRunId = lastLoopState(harness).runId as string;
					let result: ToolResult | undefined;
					let caught: unknown;
					await executeTool(harness, "loop_delegate", { name: "delegate", task: "reject once" }).then(
						(value) => { result = value; },
						(error: unknown) => {
							caught = error;
							callerCaughtAfterFailure = failureStageObserved;
						},
					);

					assert.equal(caught, row.error, `${row.name} journal error must retain identity`);
					assert.notEqual(caught, executorError);
					assert.equal(result, undefined);
					assert.equal(callerCaughtAfterFailure, true);
					assert.equal(executorCalls, 1);
					assert.equal(failedWriteAttempts, 1);
					assert.equal(failedSyncAttempts, row.stage === "write" ? 0 : 1);
					assert.equal(failedSyncCompleted, row.stage === "mirror");
					assert.equal(failedMirrorAttempts, row.stage === "mirror" ? 1 : 0);
					assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, baseline);

					const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					const lifecycle = records.filter((event) => event.kind === "delegation.updated");
					assert.deepEqual(lifecycle.map((event) => (event.payload as { status?: unknown }).status), row.stage === "write" ? ["started"] : ["started", "failed"]);
					assert.equal(lifecycle[0]?.runId, parentRunId);
					assert.equal((lifecycle[0]?.payload as { childId?: unknown }).childId, launchedChildId);
					if (row.stage !== "write") {
						assert.equal(lifecycle[1]?.runId, parentRunId);
						assert.deepEqual(lifecycle[1]?.payload, { childId: launchedChildId, status: "failed", artifactRefs: [] });
						assert.equal(lifecycle[1]?.sequence, (lifecycle[0]?.sequence as number) + 1);
					}
					const beforeProbe = { publications: { mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, records: records.length };
					await assert.rejects(() => executeTool(harness, "loop_pause", {}), /Loop journal is unhealthy/);
					await Promise.resolve();
					assert.equal(failedWriteAttempts, 1);
					assert.deepEqual({ mirrors: count("loop-event"), legacy: count("loop-delegation"), snapshots: count("loop-state") }, beforeProbe.publications);
					const afterProbe = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")).trimEnd().split("\n");
					assert.equal(afterProbe.length, beforeProbe.records);
				});
			});
		});
	}
});

test("loop_delegate publishes one durable failed association before exposing a launch rejection", async () => {
	await withTemporaryCwd(async (cwd) => {
		const order: string[] = [];
		const launchError = new Error("unique launch rejection");
		let parentRunId = "";
		let terminalPhase = false;
		let releaseFailedSync!: () => void;
		const failedSyncReleased = new Promise<void>((resolve) => {
			releaseFailedSync = resolve;
		});
		let signalFailedSync!: () => void;
		const failedSyncEntered = new Promise<void>((resolve) => {
			signalFailedSync = resolve;
		});
		let failedWriteAttempts = 0;
		let failedMirrors = 0;
		let terminalSnapshotObserved = false;
		const legacyDelegations: Array<{ runId?: unknown; childRunId?: unknown }> = [];
		const harness = createHarness({
			cwd,
			onAppendEntry(customType, data) {
				const event = data as LoopEvent;
				if (customType === "loop-event" && event.kind === "delegation.updated" && (event.payload as { status?: unknown }).status === "failed") {
					failedMirrors += 1;
					order.push("failed loop-event mirror");
				}
				if (customType === "loop-state" && failedMirrors > 0 && !terminalSnapshotObserved) {
					terminalSnapshotObserved = true;
					order.push("failed loop-state snapshot");
				}
				if (customType === "loop-delegation") legacyDelegations.push(data as { runId?: unknown; childRunId?: unknown });
			},
		});
		const launches: Array<{ childRunId: string }> = [];
		installLoop(harness, {
			delegateExecutor: {
				async launch(request) {
					launches.push(request);
					terminalPhase = true;
					throw launchError;
				},
			},
		});

		await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			if (terminalPhase && text.includes('"kind":"delegation.updated"') && text.includes('"status":"failed"')) failedWriteAttempts += 1;
			return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
		}, async () => {
			await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
				if (terminalPhase) {
					signalFailedSync();
					await failedSyncReleased;
					await (original as () => Promise<void>).call(this);
					order.push("failed sync completion");
					return;
				}
				return (original as () => Promise<void>).call(this);
			}, async () => {
				await executeTool(harness, "loop_start", { objective: "Durably record rejected launches" });
				parentRunId = lastLoopState(harness).runId as string;
				const baselineLegacy = legacyDelegations.length;
				let caught: unknown;
				const completion = executeTool(harness, "loop_delegate", { name: "delegate", task: "reject once" }).catch((error: unknown) => {
					caught = error;
					order.push("caller catch");
				});

				await failedSyncEntered;
				try {
					const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					const lifecycle = records.filter((event) => event.kind === "delegation.updated");
					assert.equal(failedWriteAttempts, 1);
					assert.deepEqual(lifecycle.map((event) => (event.payload as { status?: unknown }).status), ["started", "failed"]);
					assert.equal(failedMirrors, 0);
					assert.equal(terminalSnapshotObserved, false);
					assert.equal(caught, undefined);
				} finally {
					releaseFailedSync();
				}
				await completion;

				assert.deepEqual(order, ["failed sync completion", "failed loop-event mirror", "failed loop-state snapshot", "caller catch"]);
				assert.equal(caught, launchError);
				assert.equal(launches.length, 1);
				const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
				const lifecycle = records.filter((event) => event.kind === "delegation.updated");
				assert.equal(lifecycle.length, 2);
				const [started, failed] = lifecycle;
				const childId = (started?.payload as { childId?: unknown }).childId;
				assert.equal(typeof childId, "string");
				assert.equal(started?.runId, parentRunId);
				assert.equal(failed?.runId, parentRunId);
				assert.deepEqual(started?.payload, { childId, status: "started", artifactRefs: [] });
				assert.deepEqual(failed?.payload, { childId, status: "failed", artifactRefs: [] });
				assert.equal(failed?.sequence, (started?.sequence as number) + 1);
				assert.equal(launches[0]?.childRunId, childId);
				const [legacyDelegation] = legacyDelegations.slice(baselineLegacy);
				assert.equal(legacyDelegation?.runId, parentRunId);
				assert.equal(legacyDelegation?.childRunId, childId);
				await Promise.resolve();
				assert.equal(failedWriteAttempts, 1);
				assert.equal(failedMirrors, 1);
				assert.equal(legacyDelegations.length, baselineLegacy + 1);
			});
		});
	});
});

test("loop_delegate returns a child run id and journals its started association before returning", async () => {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", { objective: "Delegate one scoped task" });
	const parentRunId = lastLoopState(harness).runId;
	assert.equal(typeof parentRunId, "string");

	const delegated = await executeTool(harness, "loop_delegate", {
		name: "delegate",
		task: "Write one child-owned marker file",
	});
	const details = delegated.details as { childRunId?: unknown; artifactRefs?: unknown } | undefined;
	assert.equal(typeof details?.childRunId, "string");
	assert.equal(Object.hasOwn(details ?? {}, "artifactRefs"), false, "immediate delegation response must not expose terminal refs");
	assert.notEqual(details?.childRunId, parentRunId);
	assert.match(resultText(delegated), new RegExp(details!.childRunId as string));

	const lifecycle = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
	assert.equal(lifecycle.length, 2);
	assert.deepEqual(lifecycle.map((event) => event.runId), [parentRunId, parentRunId]);
	assert.deepEqual(lifecycle.map((event) => event.payload), [
		{ childId: details!.childRunId, status: "started", artifactRefs: [] },
		{ childId: details!.childRunId, status: "running", artifactRefs: [] },
	]);
});

test("loop_delegate publishes the successful child lifecycle without waiting for settlement", async () => {
	await withTemporaryCwd(async (cwd) => {
		let releaseLaunch!: () => void;
		const launchReleased = new Promise<void>((resolve) => { releaseLaunch = resolve; });
		let signalLaunch!: () => void;
		const launchEntered = new Promise<void>((resolve) => { signalLaunch = resolve; });
		let releaseSettlement!: () => void;
		const childSettled = new Promise<void>((resolve) => { releaseSettlement = resolve; });
		let signalRunningWrite!: () => void;
		const runningWriteEntered = new Promise<void>((resolve) => { signalRunningWrite = resolve; });
		let releaseRunningWrite!: () => void;
		const runningWriteReleased = new Promise<void>((resolve) => { releaseRunningWrite = resolve; });
		let signalCompletedSync!: () => void;
		const completedSyncEntered = new Promise<void>((resolve) => { signalCompletedSync = resolve; });
		let releaseCompletedSync!: () => void;
		const completedSyncReleased = new Promise<void>((resolve) => { releaseCompletedSync = resolve; });
		let parentRunId = "";
		let childRunId = "";
		let runningMirrorSawDisk = false;
		let legacyDelegation: { runId?: unknown; childRunId?: unknown } | undefined;
		let completedMirrors = 0;
		let snapshotBaseline = -1;
		const completedPublicationOrder: string[] = [];
		let artifactRefs: string[] = [];
		const launches: Array<{ parentRunId: string; childRunId: string; cwd: string; task: string }> = [];
		const harness = createHarness({
			cwd,
			onAppendEntry(customType, data) {
				const event = data as LoopEvent;
				const status = (event.payload as { status?: unknown } | undefined)?.status;
				if (customType === "loop-event" && event.kind === "delegation.updated" && status === "running") {
					const records = readFileSync(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					runningMirrorSawDisk = records.some((record) => (record.payload as { status?: unknown }).status === "running");
				}
				if (customType === "loop-event" && event.kind === "delegation.updated" && event.runId === parentRunId
					&& (event.payload as { childId?: unknown }).childId === childRunId && status === "completed") {
					completedMirrors += 1;
					completedPublicationOrder.push("completed mirror");
				}
				if (customType === "loop-delegation") legacyDelegation = data as { runId?: unknown; childRunId?: unknown };
				if (customType === "loop-state" && snapshotBaseline >= 0) completedPublicationOrder.push("loop-state");
			},
		});
		installLoop(harness, {
			delegateExecutor: {
				async launch(request) {
					launches.push(request);
					signalLaunch();
					await launchReleased;
					artifactRefs = [
						`children/${request.childRunId}/stdout.bin`,
						`children/${request.childRunId}/stderr.bin`,
					];
					return { pid: process.pid + 1, artifactRefs: Promise.resolve(artifactRefs), structuredResult: Promise.resolve(undefined), settled: childSettled };
				},
			},
		});

		await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			if (text.includes('"kind":"delegation.updated"') && text.includes('"status":"running"')) {
				signalRunningWrite();
				await runningWriteReleased;
			}
			return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
		}, async () => {
			await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
				if (childRunId && parentRunId && completedMirrors === 0) {
					signalCompletedSync();
					await completedSyncReleased;
				}
				return (original as () => Promise<void>).call(this);
			}, async () => {
				await executeTool(harness, "loop_start", { objective: "Track one successful child" });
				parentRunId = lastLoopState(harness).runId as string;
				let result: ToolResult | undefined;
				const delegation = executeTool(harness, "loop_delegate", {
					name: "delegate",
					task: "Write one child-owned marker file",
				}).then((value) => { result = value; });

				try {
					await launchEntered;
					assert.equal(launches.length, 1);
					assert.equal(loopEvents(harness).some((event) => (event.payload as { status?: unknown }).status === "running"), false);
					releaseLaunch();
					assert.equal(await Promise.race([runningWriteEntered.then(() => "running write"), delegation.then(() => "returned")]), "running write", "running must be appended before loop_delegate returns");
					assert.equal(loopEvents(harness).some((event) => (event.payload as { status?: unknown }).status === "running"), false);
					releaseRunningWrite();
					await delegation;

					childRunId = (result?.details as { childRunId?: string } | undefined)?.childRunId ?? "";
					assert.match(childRunId, /^child-[0-9a-f-]+$/);
					assert.equal(launches[0]?.parentRunId, parentRunId);
					assert.equal(launches[0]?.childRunId, childRunId);
					assert.equal(launches[0]?.cwd, cwd);
					assert.equal(launches[0]?.task, "Write one child-owned marker file");
					assert.equal(JSON.stringify(result).includes(artifactRefs[0] as string), false);
					assert.equal(legacyDelegation?.runId, parentRunId);
					assert.equal(legacyDelegation?.childRunId, childRunId);
					assert.equal(runningMirrorSawDisk, true);
					let settlementObserved = false;
					void childSettled.then(() => { settlementObserved = true; });
					await Promise.resolve();
					assert.equal(settlementObserved, false, "loop_delegate must return before child settlement");

					snapshotBaseline = harness.appendEntries.filter(({ customType }) => customType === "loop-state").length;
					releaseSettlement();
					await completedSyncEntered;
					const beforeCompletedMirror = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					assert.equal(beforeCompletedMirror.some((event) => (event.payload as { status?: unknown }).status === "completed"), true);
					assert.equal(completedMirrors, 0);
					assert.equal(harness.appendEntries.filter(({ customType }) => customType === "loop-state").length, snapshotBaseline);
					releaseCompletedSync();
					while (completedMirrors === 0 || harness.appendEntries.filter(({ customType }) => customType === "loop-state").length < snapshotBaseline + 1) {
						await new Promise<void>((resolve) => { setImmediate(resolve); });
					}
					assert.equal(harness.appendEntries.filter(({ customType }) => customType === "loop-state").length, snapshotBaseline + 1);
					assert.deepEqual(completedPublicationOrder, ["completed mirror", "loop-state"]);

					const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					const lifecycle = records.filter((event) => event.kind === "delegation.updated");
					assert.deepEqual(lifecycle.map((event) => (event.payload as { status?: unknown }).status), ["started", "running", "completed"]);
					assert.deepEqual(lifecycle.map((event) => event.runId), [parentRunId, parentRunId, parentRunId]);
					const expectedPayloads = [
						{ childId: childRunId, status: "started", artifactRefs: [] },
						{ childId: childRunId, status: "running", artifactRefs: [] },
						{ childId: childRunId, status: "completed", artifactRefs },
					];
					assert.deepEqual(lifecycle.map((event) => event.payload), expectedPayloads);
					const mirroredLifecycle = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
					assert.deepEqual(mirroredLifecycle.map((event) => event.runId), [parentRunId, parentRunId, parentRunId]);
					assert.deepEqual(mirroredLifecycle.map((event) => event.payload), expectedPayloads);
					assert.deepEqual(lifecycle.map((event) => event.sequence), [...lifecycle.keys()].map((index) => (lifecycle[0]?.sequence as number) + index));
					await executeTool(harness, "loop_status", {});
					await Promise.resolve();
					const finalRecords = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
						.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
					assert.equal(finalRecords.filter((event) => event.kind === "delegation.updated"
						&& event.runId === parentRunId
						&& (event.payload as { childId?: unknown; status?: unknown }).childId === childRunId
						&& (event.payload as { status?: unknown }).status === "completed").length, 1);
					assert.equal(loopEvents(harness).filter((event) => event.kind === "delegation.updated"
						&& event.runId === parentRunId
						&& (event.payload as { childId?: unknown; status?: unknown }).childId === childRunId
						&& (event.payload as { status?: unknown }).status === "completed").length, 1);
				} finally {
					releaseLaunch();
					releaseRunningWrite();
					releaseSettlement();
					releaseCompletedSync();
					await delegation;
				}
			});
		});
	});
});

test("loop_status and prompt expose a retained structured ref but never its payload sentinel", async () => {
	await withTemporaryCwd(async (cwd) => {
		const sentinel = "STRUCTURED_PAYLOAD_MUST_NEVER_BE_PROJECTED_9e6f";
		const harness = createHarness({ cwd });
		installLoop(harness, {
			delegateExecutor: {
				async launch(request) {
					const store = await createChildArtifactStore({ cwd: request.cwd, parentRunId: request.parentRunId, childRunId: request.childRunId });
					await store.writeStructured(Buffer.from(sentinel, "utf8"));
					const artifactRefs = await store.finalize();
					return { pid: process.pid + 1, artifactRefs: Promise.resolve(artifactRefs), structuredResult: Promise.resolve(undefined), settled: Promise.resolve() };
				},
			},
		});
		await executeTool(harness, "loop_start", { objective: "Project only validated artifact refs" });
		const parentRunId = lastLoopState(harness).runId as string;
		const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "retain opaque bytes" });
		const childRunId = (delegated.details as { childRunId: string }).childRunId;
		const structuredPath = join(cwd, ".pi", "loop", parentRunId, "children", childRunId, "structured.bin");
		assert.deepEqual(await readFile(structuredPath), Buffer.from(sentinel, "utf8"));
		const structuredRef = `children/${childRunId}/structured.bin`;
		await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
			&& (event.payload as { status?: unknown }).status === "completed"), "structured refs were not published");
		const records = await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8");
		const mirrored = JSON.stringify(loopEvents(harness));
		const status = resultText(await executeTool(harness, "loop_status", {}));
		const prompt = await requiredHandler(harness, "before_agent_start", "prompt hook required")({ type: "before_agent_start" }, harness.ctx);
		for (const projection of [records, mirrored, status, prompt.systemPrompt]) {
			assert.equal(projection.includes(sentinel), false);
			assert.equal(projection.includes(structuredRef), true);
		}
		assert.equal(records.includes("validation.completed"), false);
		assert.equal(records.includes("review.completed"), false);
	});
});

test("loop_delegate accepts every fixed artifact shape only after refs settle and projects refs without raw prose", async () => {
	const shapes = [
		[],
		["stdout.bin", "stderr.bin"],
		["stdout.bin", "stderr.bin", "final.bin"],
		["stdout.bin", "stderr.bin", "structured.bin"],
		["stdout.bin", "stderr.bin", "final.bin", "structured.bin"],
	] as const;

	for (const filenames of shapes) {
		await withTemporaryCwd(async (cwd) => {
			const settlement = deferred();
			const refsCompletion = deferred<readonly string[]>();
			const rawProse = `RAW_CHILD_PROSE_MUST_STAY_PRIVATE_${filenames.length}`;
			const harness = createHarness({ cwd });
			installLoop(harness, {
				delegateExecutor: {
					async launch() {
						return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: Promise.resolve(undefined), settled: settlement.promise };
					},
				},
			});
			await executeTool(harness, "loop_start", { objective: "Project validated artifact pointers" });
			const parentRunId = lastLoopState(harness).runId as string;
			const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: rawProse });
			const childRunId = (delegated.details as { childRunId?: string }).childRunId as string;
			const refs = filenames.map((filename) => `children/${childRunId}/${filename}`);
			const handleOwnedRefs = [...refs];
			const snapshotBaseline = harness.appendEntries.filter((entry) => entry.customType === "loop-state").length;

			settlement.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(loopEvents(harness).filter((event) => event.kind === "delegation.updated")
				.map((event) => (event.payload as { status?: unknown }).status), ["started", "running"]);
			assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-state").length, snapshotBaseline);

			refsCompletion.resolve(handleOwnedRefs);
			await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
				&& (event.payload as { status?: unknown }).status === "completed"), "completed refs were not published");
			handleOwnedRefs.push(`children/${childRunId}/mutated-after-publication.bin`);

			const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
				.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
			const canonical = records.filter((event) => event.kind === "delegation.updated");
			const mirrored = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
			const expectedPayloads = [
				{ childId: childRunId, status: "started", artifactRefs: [] },
				{ childId: childRunId, status: "running", artifactRefs: [] },
				{ childId: childRunId, status: "completed", artifactRefs: refs },
			];
			assert.deepEqual(canonical.map((event) => event.payload), expectedPayloads);
			assert.deepEqual(mirrored.map((event) => event.payload), expectedPayloads);
			assert.equal(JSON.stringify(canonical).includes("mutated-after-publication"), false);
			assert.equal(JSON.stringify(mirrored).includes("mutated-after-publication"), false);
			assert.equal(JSON.stringify(records).includes(rawProse), false);
			assert.equal(JSON.stringify(mirrored).includes(rawProse), false);
			assert.equal(records.some((event) => [
				"workspace.changed",
				"validation.completed",
				"review.completed",
				"nit.recorded",
				"blocker.raised",
			].includes(event.kind as string)), false);

			const status = resultText(await executeTool(harness, "loop_status", {}));
			const prompt = await requiredHandler(harness, "before_agent_start", "prompt hook required")({ type: "before_agent_start" }, harness.ctx);
			for (const ref of refs) {
				assert.match(status, new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
				assert.match(prompt.systemPrompt, new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
			assert.equal(status.includes(rawProse), false);
			assert.equal(prompt.systemPrompt.includes(rawProse), false);
			assert.ok((prompt.systemPrompt.split("\n\n").at(-1) ?? "").length <= 4000);
		});
	}
});

test("loop_delegate waits for valid refs on completed failed and cancelled settlements", async () => {
	const outcomes = [
		{ status: "completed", settle: (gate: Deferred<void>) => gate.resolve() },
		{ status: "failed", settle: (gate: Deferred<void>) => gate.reject(new Error("runtime failed")) },
		{ status: "cancelled", settle: (gate: Deferred<void>) => gate.reject(new DelegateCancellationError("SIGTERM")) },
	] as const;

	for (const outcome of outcomes) {
		await withTemporaryCwd(async (cwd) => {
			const settlement = deferred();
			const refsCompletion = deferred<readonly string[]>();
			const harness = createHarness({ cwd });
			let childRunId = "";
			installLoop(harness, {
				delegateExecutor: {
					async launch(request) {
						childRunId = request.childRunId;
						return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: Promise.resolve(undefined), settled: settlement.promise };
					},
				},
			});
			await executeTool(harness, "loop_start", { objective: `Await ${outcome.status} refs` });
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "Retain output pointers" });
			const refs = [
				`children/${childRunId}/stdout.bin`,
				`children/${childRunId}/stderr.bin`,
				`children/${childRunId}/structured.bin`,
			];

			outcome.settle(settlement);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(loopEvents(harness).filter((event) => event.kind === "delegation.updated").length, 2);
			refsCompletion.resolve(refs);
			await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
				&& (event.payload as { status?: unknown }).status === outcome.status), `${outcome.status} refs were not published`);

			const lifecycle = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
			assert.deepEqual(lifecycle.map((event) => event.payload), [
				{ childId: childRunId, status: "started", artifactRefs: [] },
				{ childId: childRunId, status: "running", artifactRefs: [] },
				{ childId: childRunId, status: outcome.status, artifactRefs: refs },
			]);
		});
	}
});

test("loop_delegate fails closed for unsafe or rejected artifact refs without leaking them", async () => {
	const unsafeCases: Array<{ name: string; value: (childId: string) => unknown; leaks: (childId: string) => string[] }> = [
		{ name: "absolute", value: () => ["/tmp/outside"], leaks: () => ["/tmp/outside"] },
		{ name: "traversal", value: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`, "../outside"], leaks: () => ["../outside"] },
		{ name: "wrong child", value: () => ["children/other/stdout.bin", "children/other/stderr.bin"], leaks: () => ["children/other/stdout.bin", "children/other/stderr.bin"] },
		{ name: "backslash", value: (id) => [`children\\${id}\\stdout.bin`, `children/${id}/stderr.bin`], leaks: (id) => [`children\\${id}\\stdout.bin`] },
		{ name: "unknown", value: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`, `children/${id}/unknown.bin`], leaks: (id) => [`children/${id}/unknown.bin`] },
		{ name: "duplicate", value: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`, `children/${id}/stderr.bin`], leaks: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`] },
		{ name: "reordered", value: (id) => [`children/${id}/stderr.bin`, `children/${id}/stdout.bin`], leaks: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`] },
		{ name: "missing stdout", value: (id) => [`children/${id}/stderr.bin`], leaks: (id) => [`children/${id}/stderr.bin`] },
		{ name: "missing stderr", value: (id) => [`children/${id}/stdout.bin`], leaks: (id) => [`children/${id}/stdout.bin`] },
		{ name: "optional order", value: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`, `children/${id}/structured.bin`, `children/${id}/final.bin`], leaks: (id) => [`children/${id}/structured.bin`, `children/${id}/final.bin`] },
		{ name: "non-string", value: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`, 42], leaks: (id) => [`children/${id}/stdout.bin`, `children/${id}/stderr.bin`] },
		{ name: "object", value: () => ({ ref: "UNSAFE_OBJECT_REF" }), leaks: () => ["UNSAFE_OBJECT_REF"] },
		{ name: "string", value: () => "UNSAFE_STRING_REF", leaks: () => ["UNSAFE_STRING_REF"] },
		{ name: "null", value: () => null, leaks: () => [] },
	];
	const settle = [
		(gate: Deferred<void>) => gate.resolve(),
		(gate: Deferred<void>) => gate.reject(new Error("process failed")),
		(gate: Deferred<void>) => gate.reject(new DelegateCancellationError("SIGTERM")),
	];

	for (const [index, row] of unsafeCases.entries()) {
		await withTemporaryCwd(async (cwd) => {
			const settlement = deferred();
			let childRunId = "";
			let unsafeValue: unknown;
			const harness = createHarness({ cwd });
			installLoop(harness, {
				delegateExecutor: {
					async launch(request) {
						childRunId = request.childRunId;
						unsafeValue = row.value(childRunId);
						return { pid: process.pid + 1, artifactRefs: Promise.resolve(unsafeValue as never), structuredResult: Promise.resolve(undefined), settled: settlement.promise };
					},
				},
			});
			await executeTool(harness, "loop_start", { objective: `Reject ${row.name} refs` });
			const parentRunId = lastLoopState(harness).runId as string;
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "Do not leak unsafe refs" });
			settle[index % settle.length]!(settlement);
			await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
				&& (event.payload as { status?: unknown }).status === "failed"), `${row.name} did not fail closed`);

			const recordsText = await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8");
			const lifecycle = recordsText.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent)
				.filter((event) => event.kind === "delegation.updated");
			assert.deepEqual(lifecycle.map((event) => event.payload), [
				{ childId: childRunId, status: "started", artifactRefs: [] },
				{ childId: childRunId, status: "running", artifactRefs: [] },
				{ childId: childRunId, status: "failed", artifactRefs: [] },
			]);
			const status = resultText(await executeTool(harness, "loop_status", {}));
			const prompt = await requiredHandler(harness, "before_agent_start", "prompt hook required")({ type: "before_agent_start" }, harness.ctx);
			for (const leak of row.leaks(childRunId)) {
				assert.equal(recordsText.includes(leak), false, `${row.name} leaked into JSONL`);
				assert.equal(JSON.stringify(loopEvents(harness)).includes(leak), false, `${row.name} leaked into mirrors`);
				assert.equal(status.includes(leak), false, `${row.name} leaked into status`);
				assert.equal(prompt.systemPrompt.includes(leak), false, `${row.name} leaked into prompt`);
			}
		});
	}

	for (const [index, settleProcess] of settle.entries()) {
		await withTemporaryCwd(async (cwd) => {
			const settlement = deferred();
			const refsCompletion = deferred<readonly string[]>();
			let childRunId = "";
			const harness = createHarness({ cwd });
			installLoop(harness, { delegateExecutor: { async launch(request) {
				childRunId = request.childRunId;
				return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: Promise.resolve(undefined), settled: settlement.promise };
			} } });
			await executeTool(harness, "loop_start", { objective: `Reject unavailable refs ${index}` });
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "Await rejected refs" });
			settleProcess(settlement);
			refsCompletion.reject(new Error(`artifact refs unavailable ${index}`));
			await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
				&& (event.payload as { status?: unknown }).status === "failed"), "rejected refs did not fail closed");
			const lifecycle = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
			assert.deepEqual(lifecycle.at(-1)?.payload, { childId: childRunId, status: "failed", artifactRefs: [] });
		});
	}
});

test("loop_delegate detached completed publication fails closed at each journal stage", async () => {
	const cases = [
		{ name: "canonical write", stage: "write" },
		{ name: "terminal sync", stage: "sync" },
		{ name: "loop-event mirror", stage: "mirror" },
	] as const;

	for (const row of cases) {
		await withTemporaryCwd(async (cwd) => {
			let resolveSettlement!: () => void;
			const settled = new Promise<void>((resolve) => { resolveSettlement = resolve; });
			let terminalPhase = false;
			let completedWriteAttempts = 0;
			let completedSyncAttempts = 0;
			let completedSyncCompleted = false;
			let completedMirrorAttempts = 0;
			let signalFailureStage!: () => void;
			const failureStageEntered = new Promise<void>((resolve) => { signalFailureStage = resolve; });
			const injectedFailure = new Error(`completed ${row.name} failure`);
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
			const harness = createHarness({
				cwd,
				onAppendEntry(customType, data) {
					const event = data as LoopEvent;
					if (terminalPhase && customType === "loop-event" && event.kind === "delegation.updated"
						&& (event.payload as { status?: unknown }).status === "completed") {
						completedMirrorAttempts += 1;
						if (row.stage === "mirror") {
							signalFailureStage();
							throw injectedFailure;
						}
					}
				},
			});
			installLoop(harness, {
				delegateExecutor: {
					async launch() {
						return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled };
					},
				},
			});
			const count = (type: string) => harness.appendEntries.filter((entry) => entry.customType === type).length;

			await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
				const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				if (terminalPhase && text.includes('"kind":"delegation.updated"') && text.includes('"status":"completed"')) {
					completedWriteAttempts += 1;
					if (row.stage === "write") {
						signalFailureStage();
						throw injectedFailure;
					}
				}
				return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
			}, async () => {
				await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
					if (terminalPhase && completedWriteAttempts > 0) {
						completedSyncAttempts += 1;
						if (row.stage === "sync") {
							signalFailureStage();
							throw injectedFailure;
						}
						await (original as () => Promise<void>).call(this);
						completedSyncCompleted = true;
						return;
					}
					return (original as () => Promise<void>).call(this);
				}, async () => {
					await executeTool(harness, "loop_start", { objective: `Fail closed after ${row.name}` });
					const parentRunId = lastLoopState(harness).runId as string;
					const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "settle after return" });
					const childRunId = (delegated.details as { childRunId?: string } | undefined)?.childRunId ?? "";
					assert.match(childRunId, /^child-[0-9a-f-]+$/);
					const publicationBaseline = { mirrors: count("loop-event"), snapshots: count("loop-state") };

					process.on("unhandledRejection", onUnhandled);
					try {
						terminalPhase = true;
						resolveSettlement();
						await failureStageEntered;
						await new Promise<void>((resolve) => { setImmediate(resolve); });

						const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
							.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
						const lifecycle = records.filter((event) => event.kind === "delegation.updated");
						assert.deepEqual(lifecycle.map((event) => (event.payload as { status?: unknown }).status), row.stage === "write"
							? ["started", "running"] : ["started", "running", "completed"]);
						assert.deepEqual(lifecycle.map((event) => event.runId), lifecycle.map(() => parentRunId));
						assert.deepEqual(lifecycle.map((event) => (event.payload as { childId?: unknown }).childId), lifecycle.map(() => childRunId));
						assert.equal(loopEvents(harness).some((event) => event.kind === "delegation.updated"
							&& (event.payload as { status?: unknown }).status === "completed"), false);
						assert.deepEqual({ mirrors: count("loop-event"), snapshots: count("loop-state") }, publicationBaseline);
						assert.equal(completedWriteAttempts, 1);
						assert.equal(completedSyncAttempts, row.stage === "write" ? 0 : 1);
						assert.equal(completedSyncCompleted, row.stage === "mirror");
						assert.equal(completedMirrorAttempts, row.stage === "mirror" ? 1 : 0);

						const beforeProbe = { records: records.length, mirrors: count("loop-event"), snapshots: count("loop-state") };
						await assert.rejects(() => executeTool(harness, "loop_pause", {}), /Loop journal is unhealthy/);
						await executeTool(harness, "loop_status", {});
						await new Promise<void>((resolve) => { setImmediate(resolve); });
						assert.equal(completedWriteAttempts, 1);
						assert.equal(completedSyncAttempts, row.stage === "write" ? 0 : 1);
						assert.equal(completedMirrorAttempts, row.stage === "mirror" ? 1 : 0);
						assert.deepEqual({ mirrors: count("loop-event"), snapshots: count("loop-state") }, { mirrors: beforeProbe.mirrors, snapshots: beforeProbe.snapshots });
						const afterProbe = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")).trimEnd().split("\n");
						assert.equal(afterProbe.length, beforeProbe.records);
						assert.deepEqual(unhandled, []);
					} finally {
						resolveSettlement();
						process.off("unhandledRejection", onUnhandled);
					}
				});
			});
		});
	}
});

test("terminal artifact refs fail closed at every journal stage for completed failed and cancelled outcomes", async () => {
	const outcomes = [
		{ status: "completed", settle: (gate: Deferred<void>) => gate.resolve() },
		{ status: "failed", settle: (gate: Deferred<void>) => gate.reject(new Error("runtime failed")) },
		{ status: "cancelled", settle: (gate: Deferred<void>) => gate.reject(new DelegateCancellationError("SIGTERM")) },
	] as const;
	const stages = ["write", "sync", "mirror"] as const;

	for (const outcome of outcomes) {
		for (const stage of stages) {
			await withTemporaryCwd(async (cwd) => {
				const settlement = deferred();
				const failureEntered = deferred();
				const injectedFailure = new Error(`${outcome.status} refs ${stage} failure`);
				let terminalPhase = false;
				let terminalWriteAttempts = 0;
				let terminalSyncAttempts = 0;
				let terminalMirrorAttempts = 0;
				let artifactRefs: string[] = [];
				const unhandled: unknown[] = [];
				const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
				const harness = createHarness({
					cwd,
					onAppendEntry(customType, data) {
						const event = data as LoopEvent;
						if (terminalPhase && customType === "loop-event" && event.kind === "delegation.updated"
							&& (event.payload as { status?: unknown }).status === outcome.status) {
							terminalMirrorAttempts += 1;
							if (stage === "mirror") {
								failureEntered.resolve();
								throw injectedFailure;
							}
						}
					},
				});
				installLoop(harness, { delegateExecutor: { async launch(request) {
					artifactRefs = [
						`children/${request.childRunId}/stdout.bin`,
						`children/${request.childRunId}/stderr.bin`,
					];
					return { pid: process.pid + 1, artifactRefs: Promise.resolve(artifactRefs), structuredResult: Promise.resolve(undefined), settled: settlement.promise };
				} } });
				const count = (type: string) => harness.appendEntries.filter((entry) => entry.customType === type).length;

				await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
					const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					const isTerminal = terminalPhase && text.includes('"kind":"delegation.updated"')
						&& text.includes(`"status":"${outcome.status}"`) && text.includes(artifactRefs[0] ?? "never");
					if (isTerminal) {
						terminalWriteAttempts += 1;
						if (stage === "write") {
							failureEntered.resolve();
							throw injectedFailure;
						}
					}
					return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
				}, async () => {
					await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
						if (terminalPhase && terminalWriteAttempts > 0) {
							terminalSyncAttempts += 1;
							if (stage === "sync") {
								failureEntered.resolve();
								throw injectedFailure;
							}
						}
						return (original as () => Promise<void>).call(this);
					}, async () => {
						await executeTool(harness, "loop_start", { objective: `Fail ${outcome.status} refs at ${stage}` });
						const parentRunId = lastLoopState(harness).runId as string;
						const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "Publish retained refs" });
						const childRunId = (delegated.details as { childRunId?: string }).childRunId as string;
						const baseline = { mirrors: count("loop-event"), snapshots: count("loop-state") };

						process.on("unhandledRejection", onUnhandled);
						try {
							terminalPhase = true;
							outcome.settle(settlement);
							await failureEntered.promise;
							await new Promise<void>((resolve) => setImmediate(resolve));

							const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
								.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
							const lifecycle = records.filter((event) => event.kind === "delegation.updated");
							assert.deepEqual(lifecycle.map((event) => (event.payload as { status?: unknown }).status),
								stage === "write" ? ["started", "running"] : ["started", "running", outcome.status]);
							if (stage !== "write") {
								assert.deepEqual((lifecycle.at(-1)?.payload as { artifactRefs?: unknown }).artifactRefs, artifactRefs);
							}
							assert.equal(loopEvents(harness).some((event) => event.kind === "delegation.updated"
								&& (event.payload as { childId?: unknown; status?: unknown }).childId === childRunId
								&& (event.payload as { status?: unknown }).status === outcome.status), false);
							assert.deepEqual({ mirrors: count("loop-event"), snapshots: count("loop-state") }, baseline);
							assert.equal(terminalWriteAttempts, 1);
							assert.equal(terminalSyncAttempts, stage === "write" ? 0 : 1);
							assert.equal(terminalMirrorAttempts, stage === "mirror" ? 1 : 0);

							const recordCount = records.length;
							await assert.rejects(() => executeTool(harness, "loop_pause", {}), /Loop journal is unhealthy/);
							await new Promise<void>((resolve) => setImmediate(resolve));
							assert.equal((await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8")).trimEnd().split("\n").length, recordCount);
							assert.equal(terminalWriteAttempts, 1);
							assert.deepEqual(unhandled, []);
						} finally {
							process.off("unhandledRejection", onUnhandled);
						}
					});
				});
			});
		}
	}
});

test("loop_delegate publishes exactly one first terminal outcome after duplicate and conflicting settlements", async () => {
	const outcomes = [
		{ status: "completed", settleFirst: (resolve: () => void, _reject: (reason?: unknown) => void) => resolve() },
		{ status: "failed", settleFirst: (_resolve: () => void, reject: (reason?: unknown) => void) => reject(new Error("first failure")) },
		{ status: "cancelled", settleFirst: (_resolve: () => void, reject: (reason?: unknown) => void) => reject(new DelegateCancellationError("SIGTERM")) },
	] as const;

	for (const outcome of outcomes) {
		await withTemporaryCwd(async (cwd) => {
			let resolveSettlement!: () => void;
			let rejectSettlement!: (reason?: unknown) => void;
			const settled = new Promise<void>((resolve, reject) => {
				resolveSettlement = resolve;
				rejectSettlement = reject;
			});
			const launches: Array<{ childRunId: string; artifactRefs: string[] }> = [];
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
			const harness = createHarness({ cwd });
			installLoop(harness, {
				delegateExecutor: {
					async launch(request) {
						const artifactRefs = [
							`children/${request.childRunId}/stdout.bin`,
							`children/${request.childRunId}/stderr.bin`,
						];
						launches.push({ childRunId: request.childRunId, artifactRefs });
						return { pid: process.pid + 1, artifactRefs: Promise.resolve(artifactRefs), structuredResult: Promise.resolve(undefined), settled };
					},
				},
			});

			process.on("unhandledRejection", onUnhandled);
			try {
				await executeTool(harness, "loop_start", { objective: `Keep ${outcome.status} first` });
				const parentRunId = lastLoopState(harness).runId as string;
				const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "Settle once" });
				const childRunId = (delegated.details as { childRunId?: string } | undefined)?.childRunId ?? "";
				assert.match(childRunId, /^child-[0-9a-f-]+$/);
				assert.equal(launches.length, 1);
				assert.equal(launches[0]?.childRunId, childRunId);
				assert.deepEqual(loopEvents(harness).filter((event) => event.kind === "delegation.updated").map((event) => event.payload), [
					{ childId: childRunId, status: "started", artifactRefs: [] },
					{ childId: childRunId, status: "running", artifactRefs: [] },
				]);
				const snapshotBaseline = harness.appendEntries.filter((entry) => entry.customType === "loop-state").length;

				outcome.settleFirst(resolveSettlement, rejectSettlement);
				while (loopEvents(harness).filter((event) => event.kind === "delegation.updated"
					&& event.runId === parentRunId
					&& (event.payload as { childId?: unknown; status?: unknown }).childId === childRunId
					&& (event.payload as { status?: unknown }).status === outcome.status).length === 0
					|| harness.appendEntries.filter((entry) => entry.customType === "loop-state").length < snapshotBaseline + 1) {
					await new Promise<void>((resolve) => { setImmediate(resolve); });
				}

				const terminalEntryBaseline = harness.appendEntries.length;
				const terminalRecordBaseline = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").length;
				resolveSettlement();
				rejectSettlement(new Error("late failure"));
				rejectSettlement(new DelegateCancellationError("SIGTERM"));
				await new Promise<void>((resolve) => { setImmediate(resolve); });
				await executeTool(harness, "loop_status", {});
				resolveSettlement();
				rejectSettlement(new Error("later failure"));
				await new Promise<void>((resolve) => { setImmediate(resolve); });

				const records = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
				const canonical = records.filter((event) => event.kind === "delegation.updated" && event.runId === parentRunId
					&& (event.payload as { childId?: unknown }).childId === childRunId);
				const mirrored = loopEvents(harness).filter((event) => event.kind === "delegation.updated" && event.runId === parentRunId
					&& (event.payload as { childId?: unknown }).childId === childRunId);
				const expectedPayloads = ["started", "running", outcome.status].map((status, index) => ({
					childId: childRunId,
					status,
					artifactRefs: index === 2 ? launches[0]!.artifactRefs : [],
				}));
				assert.deepEqual(canonical.map((event) => event.payload), expectedPayloads);
				assert.deepEqual(mirrored.map((event) => event.payload), expectedPayloads);
				assert.deepEqual(canonical.map((event) => event.runId), [parentRunId, parentRunId, parentRunId]);
				assert.deepEqual(mirrored.map((event) => event.runId), [parentRunId, parentRunId, parentRunId]);
				assert.deepEqual(canonical.map((event) => event.sequence), [...canonical.keys()].map((index) => (canonical[0]?.sequence as number) + index));
				assert.deepEqual(mirrored.map((event) => event.sequence), [...mirrored.keys()].map((index) => (mirrored[0]?.sequence as number) + index));
				assert.equal(canonical.some((event) => ["completed", "failed", "cancelled"].includes((event.payload as { status?: string }).status ?? "")
					&& (event.payload as { status?: string }).status !== outcome.status), false);
				assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-state").length, snapshotBaseline + 1);
				assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-delegation"
					&& (entry.data as { runId?: unknown; childRunId?: unknown }).runId === parentRunId
					&& (entry.data as { childRunId?: unknown }).childRunId === childRunId).length, 1);
				assert.equal(launches.length, 1);
				assert.equal(harness.appendEntries.length, terminalEntryBaseline);
				assert.equal(records.length, terminalRecordBaseline);
				assert.deepEqual(unhandled, []);
			} finally {
				resolveSettlement();
				process.off("unhandledRejection", onUnhandled);
			}
		});
	}
});

test("clear/restart callback isolation retains late delegated terminals with their originating run", async () => {
	const outcomes = [
		{ status: "completed", settle: (resolve: () => void, _reject: (reason?: unknown) => void) => resolve() },
		{ status: "failed", settle: (_resolve: () => void, reject: (reason?: unknown) => void) => reject(new Error("late failure")) },
		{ status: "cancelled", settle: (_resolve: () => void, reject: (reason?: unknown) => void) => reject(new DelegateCancellationError("SIGTERM")) },
	] as const;

	for (const outcome of outcomes) {
		await withTemporaryCwd(async (cwd) => {
			let resolveSettlement!: () => void;
			let rejectSettlement!: (reason?: unknown) => void;
			const settled = new Promise<void>((resolve, reject) => {
				resolveSettlement = resolve;
				rejectSettlement = reject;
			});
			let artifactRefs: string[] = [];
			let launchedRequest: Parameters<DelegateExecutor["launch"]>[0] | undefined;
			let aTerminalMirrors = 0;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
			const harness = createHarness({
				cwd,
				onAppendEntry(customType, data) {
					const event = data as LoopEvent;
					if (customType === "loop-event" && event.kind === "delegation.updated"
						&& (event.payload as { status?: unknown }).status === outcome.status) aTerminalMirrors += 1;
				},
			});
			installLoop(harness, {
				delegateExecutor: {
					async launch(request) {
						launchedRequest = request;
						artifactRefs = [
							`children/${request.childRunId}/stdout.bin`,
							`children/${request.childRunId}/stderr.bin`,
						];
						return { pid: process.pid + 1, artifactRefs: Promise.resolve(artifactRefs), structuredResult: Promise.resolve(undefined), settled };
					},
				},
			});
			process.on("unhandledRejection", onUnhandled);
			try {
				await executeTool(harness, "loop_start", { objective: `Keep late ${outcome.status} isolated`, maxIterations: 3 });
				const runA = lastLoopState(harness).runId as string;
				const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "Settle after restart" });
				const childId = (delegated.details as { childRunId?: string } | undefined)?.childRunId ?? "";
				assert.match(childId, /^child-[0-9a-f-]+$/);
				assert.equal(launchedRequest?.parentRunId, runA);
				assert.equal(JSON.stringify(delegated).includes(artifactRefs[0] as string), false);
				const beforeClear = (await readFile(join(cwd, ".pi", "loop", runA, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent)
					.filter((event) => event.kind === "delegation.updated");
				assert.deepEqual(beforeClear.map((event) => (event.payload as { status?: unknown }).status), ["started", "running"]);
				assert.deepEqual(beforeClear.map((event) => (event.payload as { artifactRefs?: unknown }).artifactRefs), [[], []]);

				await executeTool(harness, "loop_clear", {});
				await executeTool(harness, "loop_start", { objective: "Run B stays current", maxIterations: 3 });
				const runB = lastLoopState(harness).runId as string;
				assert.notEqual(runB, runA);
				assert.equal(launchedRequest?.parentRunId, runA);
				const snapshotsBeforePublications = harness.appendEntries.filter((entry) => entry.customType === "loop-state").length;

				outcome.settle(resolveSettlement, rejectSettlement);
				await requiredHandler(harness, "agent_start", "B iteration hook required")({ type: "agent_start" }, harness.ctx);
				while (aTerminalMirrors === 0) await new Promise<void>((resolve) => { setImmediate(resolve); });

				const readEvents = async (runId: string) => (await readFile(join(cwd, ".pi", "loop", runId, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
				const aEvents = await readEvents(runA);
				const bEvents = await readEvents(runB);
				const aLifecycle = aEvents.filter((event) => event.kind === "delegation.updated");
				assert.deepEqual(aLifecycle.map((event) => (event.payload as { status?: unknown }).status), ["started", "running", outcome.status]);
				assert.deepEqual(aLifecycle.map((event) => event.runId), [runA, runA, runA]);
				assert.deepEqual(aLifecycle.map((event) => (event.payload as { childId?: unknown }).childId), [childId, childId, childId]);
				assert.deepEqual(aLifecycle.map((event) => (event.payload as { artifactRefs?: unknown }).artifactRefs), [[], [], artifactRefs]);
				assert.deepEqual(aEvents.map((event) => event.sequence), aEvents.map((_event, index) => index + 1));
				assert.equal(bEvents.some((event) => JSON.stringify(event).includes(childId)), false);
				assert.equal(JSON.stringify(bEvents).includes(artifactRefs[0] as string), false);
				assert.equal(JSON.stringify(bEvents).includes(artifactRefs[1] as string), false);
				assert.ok(bEvents.some((event) => event.kind === "loop.iteration"));
				assert.deepEqual(bEvents.map((event) => event.sequence), bEvents.map((_event, index) => index + 1));

				const mirrors = loopEvents(harness);
				const aTerminalMirrorsPayload = mirrors.filter((event) => event.runId === runA
					&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
					&& (event.payload as { status?: unknown }).status === outcome.status);
				assert.equal(aTerminalMirrorsPayload.length, 1);
				assert.deepEqual((aTerminalMirrorsPayload[0]?.payload as { artifactRefs?: unknown }).artifactRefs, artifactRefs);
				assert.equal(mirrors.some((event) => event.runId === runB && JSON.stringify(event).includes(childId)), false);
				assert.equal(harness.appendEntries.filter((entry) => entry.customType === "loop-state").length, snapshotsBeforePublications + 1);
				assert.equal(lastLoopState(harness).runId, runB);

				const status = await executeTool(harness, "loop_status", {});
				assert.doesNotMatch(resultText(status), new RegExp(childId));
				assert.equal(resultText(status).includes(artifactRefs[0] as string), false);
				const prompt = await requiredHandler(harness, "before_agent_start", "prompt hook required")({ type: "before_agent_start" }, harness.ctx);
				assert.doesNotMatch(prompt.systemPrompt, new RegExp(childId));
				assert.equal(prompt.systemPrompt.includes(artifactRefs[0] as string), false);
				await requiredHandler(harness, "session_compact", "recovery hook required")(sessionCompactEvent(), harness.ctx);
				assert.equal(lastLoopState(harness).runId, runB);
				await requiredHandler(harness, "agent_start", "B iteration hook required")({ type: "agent_start" }, harness.ctx);
				assert.deepEqual((await readEvents(runB)).map((event) => event.sequence), bEvents.concat({}).map((_event, index) => index + 1));
				await new Promise<void>((resolve) => { setImmediate(resolve); });
				assert.deepEqual(unhandled, []);
			} finally {
				resolveSettlement();
				process.off("unhandledRejection", onUnhandled);
			}
		});
	}
});

test("loop_delegate publishes one durable runtime failed association after settlement rejection", async () => {
	await withTemporaryCwd(async (cwd) => {
		let rejectSettlement!: (error: Error) => void;
		const childSettled = new Promise<void>((_resolve, reject) => { rejectSettlement = reject; });
		let releaseFailedSync!: () => void;
		const failedSyncReleased = new Promise<void>((resolve) => { releaseFailedSync = resolve; });
		let signalFailedSync!: () => void;
		const failedSyncEntered = new Promise<void>((resolve) => { signalFailedSync = resolve; });
		let parentRunId = "";
		let childRunId = "";
		let failedMirrors = 0;
		let snapshotBaseline = -1;
		const publicationOrder: string[] = [];
		const launches: Array<{ childRunId: string; cwd: string; task: string }> = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		const harness = createHarness({
			cwd,
			onAppendEntry(customType, data) {
				const event = data as LoopEvent;
				const payload = event.payload as { childId?: unknown; status?: unknown } | undefined;
				if (customType === "loop-event" && event.kind === "delegation.updated" && event.runId === parentRunId
					&& payload?.childId === childRunId && payload.status === "failed") {
					failedMirrors += 1;
					publicationOrder.push("failed loop-event mirror");
				}
				if (customType === "loop-state" && snapshotBaseline >= 0) publicationOrder.push("failed loop-state snapshot");
			},
		});
		installLoop(harness, {
			delegateExecutor: {
				async launch(request) {
					launches.push(request);
					return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled: childSettled };
				},
			},
		});

		process.on("unhandledRejection", onUnhandled);
		try {
			await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
				if (childRunId && failedMirrors === 0) {
					signalFailedSync();
					await failedSyncReleased;
					publicationOrder.push("failed sync completion");
				}
				return (original as () => Promise<void>).call(this);
			}, async () => {
				await executeTool(harness, "loop_start", { objective: "Track one runtime-failed child" });
				parentRunId = lastLoopState(harness).runId as string;
				const delegated = await executeTool(harness, "loop_delegate", {
					name: "delegate",
					task: "Write one child-owned marker file",
				});
				childRunId = (delegated.details as { childRunId?: string } | undefined)?.childRunId ?? "";
				assert.match(childRunId, /^child-[0-9a-f-]+$/);
				assert.equal(launches.length, 1);
				assert.equal(launches[0]?.childRunId, childRunId);
				assert.equal(launches[0]?.cwd, cwd);
				assert.equal(launches[0]?.task, "Write one child-owned marker file");
				assert.deepEqual(loopEvents(harness).filter((event) => event.kind === "delegation.updated").map((event) => event.payload), [
					{ childId: childRunId, status: "started", artifactRefs: [] },
					{ childId: childRunId, status: "running", artifactRefs: [] },
				]);

				snapshotBaseline = harness.appendEntries.filter(({ customType }) => customType === "loop-state").length;
				const runtimeError = new Error("controlled post-launch settlement failure");
				rejectSettlement(runtimeError);
				assert.equal(await Promise.race([
					failedSyncEntered.then(() => "failed sync"),
					new Promise<string>((resolve) => { setTimeout(() => resolve("timed out"), 100); }),
				]), "failed sync", "settlement rejection must publish failed after loop_delegate returned");

				const beforeMirror = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
				const lifecycleBeforeMirror = beforeMirror.filter((event) => event.kind === "delegation.updated");
				assert.deepEqual(lifecycleBeforeMirror.map((event) => event.runId), [parentRunId, parentRunId, parentRunId]);
				assert.deepEqual(lifecycleBeforeMirror.map((event) => event.payload), [
					{ childId: childRunId, status: "started", artifactRefs: [] },
					{ childId: childRunId, status: "running", artifactRefs: [] },
					{ childId: childRunId, status: "failed", artifactRefs: [] },
				]);
				assert.equal(failedMirrors, 0);
				assert.equal(harness.appendEntries.filter(({ customType }) => customType === "loop-state").length, snapshotBaseline);
				releaseFailedSync();
				while (failedMirrors === 0 || harness.appendEntries.filter(({ customType }) => customType === "loop-state").length < snapshotBaseline + 1) {
					await new Promise<void>((resolve) => { setImmediate(resolve); });
				}
				assert.deepEqual(publicationOrder, ["failed sync completion", "failed loop-event mirror", "failed loop-state snapshot"]);
				const lifecycle = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
				assert.deepEqual(lifecycle.map((event) => event.payload), [
					{ childId: childRunId, status: "started", artifactRefs: [] },
					{ childId: childRunId, status: "running", artifactRefs: [] },
					{ childId: childRunId, status: "failed", artifactRefs: [] },
				]);
				assert.equal(lifecycle.filter((event) => (event.payload as { status?: unknown }).status === "failed").length, 1);
				assert.equal(lifecycle.some((event) => (event.payload as { status?: unknown }).status === "completed"), false);
				assert.deepEqual(lifecycle.map((event) => event.sequence), [...lifecycle.keys()].map((index) => (lifecycle[0]?.sequence as number) + index));
				await new Promise<void>((resolve) => { setImmediate(resolve); });
				assert.deepEqual(unhandled, []);
			});
		} finally {
			releaseFailedSync();
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("loop_delegate publishes one durable cancelled association after typed cancellation settlement", async () => {
	await withTemporaryCwd(async (cwd) => {
		let rejectSettlement!: (error: Error) => void;
		const settled = new Promise<void>((_resolve, reject) => { rejectSettlement = reject; });
		let releaseSync!: () => void;
		const syncReleased = new Promise<void>((resolve) => { releaseSync = resolve; });
		let signalSync!: () => void;
		const syncEntered = new Promise<void>((resolve) => { signalSync = resolve; });
		let parentRunId = "";
		let childRunId = "";
		let cancelledMirrors = 0;
		let snapshotBaseline = -1;
		const publicationOrder: string[] = [];
		const legacyDelegations: Array<{ runId?: unknown; childRunId?: unknown }> = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		const harness = createHarness({
			cwd,
			onAppendEntry(customType, data) {
				const event = data as LoopEvent;
				const payload = event.payload as { childId?: unknown; status?: unknown } | undefined;
				if (customType === "loop-event" && event.kind === "delegation.updated" && event.runId === parentRunId
					&& payload?.childId === childRunId && payload.status === "cancelled") {
					cancelledMirrors += 1;
					publicationOrder.push("cancelled mirror");
				}
				if (customType === "loop-state" && snapshotBaseline >= 0) publicationOrder.push("snapshot");
				if (customType === "loop-delegation") legacyDelegations.push(data as { runId?: unknown; childRunId?: unknown });
			},
		});
		installLoop(harness, { delegateExecutor: { async launch() { return { pid: process.pid + 1, artifactRefs: Promise.resolve([]), structuredResult: Promise.resolve(undefined), settled }; } } });
		process.on("unhandledRejection", onUnhandled);
		try {
			await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
				if (childRunId && cancelledMirrors === 0) {
					signalSync();
					await syncReleased;
					publicationOrder.push("sync");
				}
				return (original as () => Promise<void>).call(this);
			}, async () => {
				await executeTool(harness, "loop_start", { objective: "Track one cancelled child" });
				parentRunId = lastLoopState(harness).runId as string;
				const delegated = await executeTool(harness, "loop_delegate", { name: "delegate", task: "Wait for cancellation" });
				childRunId = (delegated.details as { childRunId?: string } | undefined)?.childRunId ?? "";
				assert.match(childRunId, /^child-[0-9a-f-]+$/);
				assert.equal(legacyDelegations.length, 1);
				assert.equal(legacyDelegations[0]?.runId, parentRunId);
				assert.equal(legacyDelegations[0]?.childRunId, childRunId);
				snapshotBaseline = harness.appendEntries.filter(({ customType }) => customType === "loop-state").length;

				rejectSettlement(new DelegateCancellationError("SIGTERM"));
				await syncEntered;
				const beforeMirror = (await readFile(join(cwd, ".pi", "loop", parentRunId, "events.jsonl"), "utf8"))
					.trimEnd().split("\n").map((line) => JSON.parse(line) as LoopEvent);
				const canonicalLifecycle = beforeMirror.filter((event) => event.kind === "delegation.updated");
				assert.deepEqual(canonicalLifecycle.map((event) => event.runId), [parentRunId, parentRunId, parentRunId]);
				assert.deepEqual(canonicalLifecycle.map((event) => event.payload), [
					{ childId: childRunId, status: "started", artifactRefs: [] },
					{ childId: childRunId, status: "running", artifactRefs: [] },
					{ childId: childRunId, status: "cancelled", artifactRefs: [] },
				]);
				assert.equal(cancelledMirrors, 0);
				assert.equal(harness.appendEntries.filter(({ customType }) => customType === "loop-state").length, snapshotBaseline);
				releaseSync();
				while (cancelledMirrors === 0 || harness.appendEntries.filter(({ customType }) => customType === "loop-state").length < snapshotBaseline + 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
				assert.deepEqual(publicationOrder, ["sync", "cancelled mirror", "snapshot"]);
				const lifecycle = loopEvents(harness).filter((event) => event.kind === "delegation.updated");
				assert.equal(lifecycle.filter((event) => (event.payload as { status?: unknown }).status === "cancelled").length, 1);
				assert.equal(lifecycle.some((event) => ["failed", "completed"].includes((event.payload as { status?: string }).status ?? "")), false);
				assert.equal(legacyDelegations.length, 1);
				await new Promise<void>((resolve) => { setImmediate(resolve); });
				assert.deepEqual(unhandled, []);
			});
		} finally {
			releaseSync();
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("before_agent_start injects the latest projected decision context without raw JSONL", async () => {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", {
		objective: "Coordinate implementation through delegated workers",
		maxIterations: 4,
	});
	await executeTool(harness, "loop_delegate", { name: "delegate", task: "Implement the projector" });

	const beforeAgentStart = requiredHandler(
		harness,
		"before_agent_start",
		"active loop mode must install a before_agent_start prompt hook",
	);
	const result = await beforeAgentStart({ type: "before_agent_start" }, harness.ctx);
	const prompt = result?.systemPrompt as string;
	assert.match(prompt, /orchestrator|control-plane/i);
	assert.match(prompt, /Loop decision context/);
	assert.match(prompt, /Lifecycle: active/);
	assert.match(prompt, /delegation child-/);
	assert.doesNotMatch(prompt, /"schemaVersion"|events\.jsonl/);
});

test("loop_status consumes the same projection as supervisor decision context", async () => {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", {
		objective: "Ship projected status",
		maxIterations: 3,
		maxTokens: 123,
	});
	await executeTool(harness, "loop_delegate", { name: "delegate", task: "Gather evidence" });

	const status = resultText(await executeTool(harness, "loop_status", {}));
	assert.match(status, /active/i);
	assert.match(status, /Ship projected status/);
	assert.match(status, /0\s*\/\s*3/);
	assert.match(status, /Loop decision context/);
	assert.match(status, /delegation child-/);
	assert.match(status, /highWater=/);
});

test("loop_complete journals assessments and rejects missing or cross-run event provenance", async () => {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", {
		objective: ["Requirements:", "1. Record the plan.", "2. Record the verification."].join("\n"),
	});
	await executeTool(harness, "loop_write", { file: "plan.md", content: "plan body" });
	await executeTool(harness, "loop_write", { file: "evidence.md", content: "evidence body" });
	await executeTool(harness, "loop_delegate", { name: "delegate", task: "Verify plan and evidence" });

	const knownSequences = loopEvents(harness).map((event) => event.sequence as number);
	assert.ok(knownSequences.length >= 2);

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1: Evidence: plan.md.\nRequirement 2: Evidence: evidence.md.",
				assessments: [
					{ requirementId: "1", verdict: "satisfied", eventSequences: [knownSequences[0]] },
					// Missing assessment for requirement 2 intentionally omitted after first only — actually both needed.
				],
			}),
		/missing or cross-run event sequence 1/i,
	);

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1: Evidence: plan.md.\nRequirement 2: Evidence: evidence.md.",
				assessments: [
					{ requirementId: "1", verdict: "satisfied", eventSequences: [999] },
					{ requirementId: "2", verdict: "satisfied", eventSequences: [knownSequences[0]] },
				],
			}),
		/missing or cross-run event sequence 999/i,
	);

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: "Requirement 1: Evidence: plan.md.\nRequirement 2: Evidence: evidence.md.",
				assessments: [
					{ requirementId: "1", verdict: "satisfied", eventSequences: [knownSequences[0]!] },
					{ requirementId: "2", verdict: "satisfied", eventSequences: [knownSequences.at(-1)!] },
				],
			}),
		/missing or cross-run event sequence/i,
	);
	assert.equal(lastLoopState(harness).state, "active");
});

test("loop_complete rejects a started-only delegation sequence as summary evidence", async () => {
	const harness = createHarness();
	installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
	await executeTool(harness, "loop_start", {
		objective: "Requirements:\n1. Ship the feature.",
	});
	await executeTool(harness, "loop_delegate", { name: "delegate", task: "Ship it" });
	const startedSequence = loopEvents(harness).find(
		(event) => event.kind === "delegation.updated" && (event.payload as { status?: unknown }).status === "started",
	)?.sequence;
	assert.equal(typeof startedSequence, "number");
	const completedSequence = await completedDelegationSequence(
		harness,
		"completed delegation evidence was not published",
		lastLoopState(harness).runId as string,
	);
	const assessments = [{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequence] }];

	await assert.rejects(
		() =>
			executeTool(harness, "loop_complete", {
				summary: `Requirement 1: verified. Evidence: #${startedSequence}.`,
				assessments,
			}),
		/missing evidence|Requirement 1/i,
	);
	assert.equal(lastLoopState(harness).state, "active");
});

test("loop_complete rejects operational event summary evidence and leaves the loop active", async () => {
	const harness = createHarness();
	installLoop(harness, { delegateExecutor: completedDelegateExecutor() });
	await executeTool(harness, "loop_start", { objective: "Requirements:\n1. Ship the feature." });
	const startedSequence = loopEvents(harness).find((event) => event.kind === "loop.started")?.sequence;
	assert.equal(typeof startedSequence, "number");
	const assessments = await completedAssessment(harness, "Record assessment evidence");

	await assert.rejects(
		() => executeTool(harness, "loop_complete", {
			summary: `Requirement 1: verified. Evidence: #${startedSequence}.`,
			assessments,
		}),
		/missing evidence|Requirement 1/i,
	);
	assert.equal(lastLoopState(harness).state, "active");
});

test("assessment completion rejects operational event provenance and leaves the loop active", async () => {
	const harness = createHarness();
	installLoop(harness);
	await executeTool(harness, "loop_start", { objective: "Requirements:\n1. Ship the feature." });
	await executeTool(harness, "loop_write", { file: "evidence.md", content: "safe evidence" });
	const startedSequence = loopEvents(harness).find((event) => event.kind === "loop.started")?.sequence;
	assert.equal(typeof startedSequence, "number");

	await assert.rejects(
		() => executeTool(harness, "loop_complete", {
			summary: "Requirement 1: verified. Evidence: evidence.md.",
			assessments: [{ requirementId: "1", verdict: "satisfied", eventSequences: [startedSequence] }],
		}),
		/missing or cross-run event sequence/i,
	);
	assert.equal(lastLoopState(harness).state, "active");
});

test("loop_complete accepts completed delegation and typed child facts as provenance", async () => {
	const settlement = deferred();
	const refsCompletion = deferred<readonly string[]>();
	const structuredCompletion = deferred<ReturnType<typeof allFieldsStructuredResult>>();
	let childId = "";
	const harness = createHarness();
	installLoop(harness, { delegateExecutor: { async launch(request) {
		childId = request.childRunId;
		return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: structuredCompletion.promise, settled: settlement.promise };
	} } });
	await executeTool(harness, "loop_start", { objective: "Requirements:\n1. Ship the feature." });
	const runId = lastLoopState(harness).runId as string;

	await executeTool(harness, "loop_delegate", { name: "delegate", task: "Ship it" });
	assert.equal(loopEvents(harness).some((event) => event.kind === "delegation.updated"
		&& (event.payload as { status?: unknown }).status === "completed"), false);
	const refs = childRuntimeRefs(childId);
	settlement.resolve();
	refsCompletion.resolve(refs);
	structuredCompletion.resolve(allFieldsStructuredResult(childId, [refs[2]! ]));
	const completedSequence = await completedDelegationSequence(harness, "completed child was not published");
	const validationSequence = loopEvents(harness).find((event) => event.kind === "validation.completed")?.sequence;
	assert.equal(typeof completedSequence, "number");
	assert.equal(typeof validationSequence, "number");

	await executeTool(harness, "loop_complete", {
		summary: `Requirement 1: verified. Evidence: #${completedSequence}, #${validationSequence}.`,
		assessments: [{ requirementId: "1", verdict: "satisfied", eventSequences: [completedSequence, validationSequence] }],
	});
	assert.equal(lastLoopState(harness).state, "complete");
	const assessments = loopEvents(harness).filter((event) => event.kind === "supervisor.assessment");
	assert.deepEqual(assessments.map((event) => event.payload), [{
		requirementId: "1",
		verdict: "satisfied",
		references: [{ runId, sequence: completedSequence }, { runId, sequence: validationSequence }],
	}]);
	const completedIndex = loopEvents(harness).findIndex((event) => event.kind === "loop.completed");
	assert.ok(assessments.every((event) => loopEvents(harness).indexOf(event) < completedIndex));
});

test("loop_delegate rejects ineligible structured authority without adding facts or terminal fields", async () => {
	const rejected = <T>(reason: unknown): Promise<T> => {
		const promise = Promise.reject(reason) as Promise<T>;
		void promise.catch(() => undefined);
		return promise;
	};
	const rows: Array<{
		name: string;
		settled: () => Promise<void>;
		structured: (childId: string, refs: readonly string[]) => Promise<ReturnType<typeof allFieldsStructuredResult> | undefined>;
		refs: (childId: string) => readonly string[];
		expectedStatus: "completed" | "failed" | "cancelled";
	}> = [
		{
			name: "failed process",
			settled: () => rejected(new Error("child failed")),
			structured: (id, refs) => Promise.resolve(allFieldsStructuredResult(id, [refs[2]!])),
			refs: childRuntimeRefs,
			expectedStatus: "failed",
		},
		{
			name: "cancelled process",
			settled: () => rejected(new DelegateCancellationError("SIGTERM")),
			structured: (id, refs) => Promise.resolve(allFieldsStructuredResult(id, [refs[2]!])),
			refs: childRuntimeRefs,
			expectedStatus: "cancelled",
		},
		{
			name: "undefined result",
			settled: () => Promise.resolve(),
			structured: () => Promise.resolve(undefined),
			refs: childRuntimeRefs,
			expectedStatus: "completed",
		},
		{
			name: "rejected result",
			settled: () => Promise.resolve(),
			structured: () => rejected(new Error("structured infrastructure failure")),
			refs: childRuntimeRefs,
			expectedStatus: "failed",
		},
		{
			name: "missing structured runtime ref",
			settled: () => Promise.resolve(),
			structured: (id) => Promise.resolve(allFieldsStructuredResult(id, [`children/${id}/structured.bin`])),
			refs: (id) => childRuntimeRefs(id).slice(0, 2),
			expectedStatus: "completed",
		},
		{
			name: "duplicate reported ref",
			settled: () => Promise.resolve(),
			structured: (id, refs) => Promise.resolve(allFieldsStructuredResult(id, [refs[2]!, refs[2]!])),
			refs: childRuntimeRefs,
			expectedStatus: "completed",
		},
		{
			name: "foreign reported ref",
			settled: () => Promise.resolve(),
			structured: (id) => Promise.resolve(allFieldsStructuredResult(id, ["children/other/structured.bin"])),
			refs: childRuntimeRefs,
			expectedStatus: "completed",
		},
		{
			name: "unsafe reported ref",
			settled: () => Promise.resolve(),
			structured: (id) => Promise.resolve(allFieldsStructuredResult(id, ["../structured.bin"])),
			refs: childRuntimeRefs,
			expectedStatus: "completed",
		},
		{
			name: "safe same-child non-member reported ref",
			settled: () => Promise.resolve(),
			structured: (id) => Promise.resolve(allFieldsStructuredResult(id, [`children/${id}/final.bin`])),
			refs: childRuntimeRefs,
			expectedStatus: "completed",
		},
	];

	for (const row of rows) {
		await withTemporaryCwd(async (cwd) => {
			let childId = "";
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
			const harness = createHarness({ cwd });
			installLoop(harness, { delegateExecutor: { async launch(request) {
				childId = request.childRunId;
				const refs = row.refs(childId);
				return { pid: process.pid + 1, artifactRefs: Promise.resolve(refs), structuredResult: row.structured(childId, refs), settled: row.settled() };
			} } });
			process.on("unhandledRejection", onUnhandled);
			try {
				await executeTool(harness, "loop_start", { objective: `Reject ${row.name}` });
				const runId = lastLoopState(harness).runId as string;
				await executeTool(harness, "loop_delegate", { name: "delegate", task: "caller prose is not authority" });
				await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
					&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
					&& (event.payload as { status?: unknown }).status === row.expectedStatus), `${row.name} terminal was not published`);
				await assertChildEventsInStores(cwd, runId, harness, childId, [
					["delegation.updated", { childId, status: "started", artifactRefs: [] }],
					["delegation.updated", { childId, status: "running", artifactRefs: [] }],
					["delegation.updated", { childId, status: row.expectedStatus, artifactRefs: [...row.refs(childId)] }],
				], row.name);
				await tick();
				assert.deepEqual(unhandled, [], `${row.name} must not leak detached rejection`);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	}
});

test("loop_delegate gates structured authority on all three structured child promises", async () => {
	const orders = [
		["settled", "artifactRefs", "structuredResult"],
		["settled", "structuredResult", "artifactRefs"],
		["artifactRefs", "settled", "structuredResult"],
		["artifactRefs", "structuredResult", "settled"],
		["structuredResult", "settled", "artifactRefs"],
		["structuredResult", "artifactRefs", "settled"],
	] as const;
	assert.equal(new Set(orders.map((order) => order.join(","))).size, 6);
	let executed = 0;
	for (const order of orders) {
		await withTemporaryCwd(async (cwd) => {
			const settlement = deferred();
			const refsCompletion = deferred<readonly string[]>();
			const structuredCompletion = deferred<ReturnType<typeof allFieldsStructuredResult>>();
			let childId = "";
			const harness = createHarness({ cwd });
			installLoop(harness, { delegateExecutor: { async launch(request) {
				childId = request.childRunId;
				return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: structuredCompletion.promise, settled: settlement.promise };
			} } });
			await executeTool(harness, "loop_start", { objective: `Gate ${order.join(" then ")}` });
			const runId = lastLoopState(harness).runId as string;
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "opaque prose must not be authority" });
			const refs = childRuntimeRefs(childId);
			const structuredRef = refs[2];
			const beforeCompletion: Array<readonly [unknown, unknown]> = [
				["delegation.updated", { childId, status: "started", artifactRefs: [] }],
				["delegation.updated", { childId, status: "running", artifactRefs: [] }],
			];
			const release = {
				settled: () => settlement.resolve(),
				artifactRefs: () => refsCompletion.resolve(refs),
				structuredResult: () => structuredCompletion.resolve(allFieldsStructuredResult(childId, [structuredRef])),
			};
			for (const [index, gate] of order.entries()) {
				release[gate]();
				await tick();
				if (index < 2) await assertChildEventsInStores(cwd, runId, harness, childId, beforeCompletion, `${order.join(" → ")} gate ${index + 1}`);
			}
			await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
				&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
				&& (event.payload as { status?: unknown }).status === "completed"), `${order.join(" → ")} did not complete`);
			await assertChildEventsInStores(cwd, runId, harness, childId, [
				...beforeCompletion,
				["workspace.changed", { childId, files: ["src/a.ts"] }],
				["validation.completed", { childId, command: "npm test", outcome: "passed" }],
				["review.completed", { childId, verdict: "APPROVE", findings: [] }],
				["nit.recorded", { childId, message: "minor" }],
				["blocker.raised", { childId, message: "blocked" }],
				["delegation.updated", {
					childId,
					status: "completed",
					artifactRefs: [...refs],
					summary: "structured summary",
					confidence: 0,
					classification: "complete",
					resultArtifactRefs: [structuredRef],
				}],
			], order.join(" → "));
			executed += 1;
		});
	}
	assert.equal(executed, 6);
});

test("loop_delegate gates a late rejected structured child promise among three structured child promises without unhandled rejection", async () => {
	await withTemporaryCwd(async (cwd) => {
		const settlement = deferred();
		const refsCompletion = deferred<readonly string[]>();
		const structuredCompletion = deferred<ReturnType<typeof allFieldsStructuredResult>>();
		let childId = "";
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: { async launch(request) {
			childId = request.childRunId;
			return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: structuredCompletion.promise, settled: settlement.promise };
		} } });
		process.on("unhandledRejection", onUnhandled);
		try {
			await executeTool(harness, "loop_start", { objective: "Reject late structured authority" });
			const runId = lastLoopState(harness).runId as string;
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "opaque prose must not be authority" });
			const refs = childRuntimeRefs(childId);
			settlement.resolve();
			await tick();
			refsCompletion.resolve(refs);
			await tick();
			await assertChildEventsInStores(cwd, runId, harness, childId, [
				["delegation.updated", { childId, status: "started", artifactRefs: [] }],
				["delegation.updated", { childId, status: "running", artifactRefs: [] }],
			], "process and refs must not publish authority");
			structuredCompletion.reject(new Error("late structured infrastructure failure"));
			await waitUntil(() => loopEvents(harness).some((event) => event.kind === "delegation.updated"
				&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
				&& (event.payload as { status?: unknown }).status === "failed"), "late structured rejection was not published");
			await assertChildEventsInStores(cwd, runId, harness, childId, [
				["delegation.updated", { childId, status: "started", artifactRefs: [] }],
				["delegation.updated", { childId, status: "running", artifactRefs: [] }],
				["delegation.updated", { childId, status: "failed", artifactRefs: [...refs] }],
			], "late structured rejection");
			await tick();
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("loop_delegate structured typed fact failures fail closed at every canonical and Pi mirror stage", async () => {
	let executed = 0;
	for (const kind of ALL_FIELDS_TYPED_KINDS) for (const stage of ["canonical write", "Pi mirror"] as const) {
		await withTemporaryCwd(async (cwd) => {
			let childId = "";
			let active = false;
			let injections = 0;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
			const harness = createHarness({ cwd, onAppendEntry(customType, data) {
				const event = data as LoopEvent;
				if (active && stage === "Pi mirror" && customType === "loop-event" && event.kind === kind) {
					injections += 1;
					throw new Error(`${kind} mirror failed`);
				}
			} });
			installLoop(harness, { delegateExecutor: { async launch(request) {
				childId = request.childRunId;
				const refs = childRuntimeRefs(childId);
				return { pid: process.pid + 1, artifactRefs: Promise.resolve(refs), structuredResult: Promise.resolve(allFieldsStructuredResult(childId, [refs[2]!])), settled: Promise.resolve() };
			} } });
			process.on("unhandledRejection", onUnhandled);
			try {
				await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
					const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					if (active && stage === "canonical write" && text.includes(`"kind":"${kind}"`)) {
						injections += 1;
						throw new Error(`${kind} write failed`);
					}
					return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
				}, async () => {
					await executeTool(harness, "loop_start", { objective: `${kind} ${stage}` });
					const runId = lastLoopState(harness).runId as string;
					active = true;
					await executeTool(harness, "loop_delegate", { name: "delegate", task: "publish structured facts" });
					await waitUntil(() => injections === 1, `${kind} ${stage} was not injected`);
					await tick();
					const typed = allFieldsTypedFacts(childId);
					const target = ALL_FIELDS_TYPED_KINDS.indexOf(kind);
					const lifecycle = childLifecycleEvents(childId);
					const stores = await childEventsInStores(cwd, runId, harness, childId);
					assert.equal(injections, 1);
					assert.deepEqual(stores.canonical, [...lifecycle, ...typed.slice(0, target + (stage === "Pi mirror" ? 1 : 0))]);
					assert.deepEqual(stores.mirror, [...lifecycle, ...typed.slice(0, target)]);
					await assertPoisonedLoopPauseLeavesOriginUnchanged(cwd, runId, harness);
					assert.deepEqual(await childEventsInStores(cwd, runId, harness, childId), stores);
					assert.deepEqual(unhandled, []);
				});
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
		executed += 1;
	}
	assert.equal(executed, 10);
});

test("loop_delegate enriched structured terminal failures retain only stage-committed authority", async () => {
	const stages = ["canonical write", "terminal sync", "Pi mirror"] as const;
	let executed = 0;
	for (const stage of stages) {
		await withTemporaryCwd(async (cwd) => {
			let childId = "";
			let active = false;
			let terminalWritten = false;
			let injections = 0;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
			const harness = createHarness({ cwd, onAppendEntry(customType, data) {
				const event = data as LoopEvent;
				if (
					active
					&& stage === "Pi mirror"
					&& customType === "loop-event"
					&& event.kind === "delegation.updated"
					&& (event.payload as { status?: unknown }).status === "completed"
				) {
					injections += 1;
					throw new Error("completed mirror failed");
				}
			} });
			installLoop(harness, { delegateExecutor: { async launch(request) {
				childId = request.childRunId;
				const refs = childRuntimeRefs(childId);
				return { pid: process.pid + 1, artifactRefs: Promise.resolve(refs), structuredResult: Promise.resolve(allFieldsStructuredResult(childId, [refs[2]!])), settled: Promise.resolve() };
			} } });
			process.on("unhandledRejection", onUnhandled);
			try {
				await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
					const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					const isEnrichedTerminal = active
						&& text.includes('"kind":"delegation.updated"')
						&& text.includes('"status":"completed"')
						&& text.includes('"summary":"structured summary"');
					if (isEnrichedTerminal) {
						if (stage === "canonical write") {
							injections += 1;
							throw new Error("completed write failed");
						}
						terminalWritten = true;
					}
					return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
				}, async () => {
					await withFileHandleMethod("sync", (original) => async function sync(this: FileHandle) {
						if (terminalWritten && stage === "terminal sync") {
							injections += 1;
							throw new Error("completed sync failed");
						}
						return (original as () => Promise<void>).call(this);
					}, async () => {
						await executeTool(harness, "loop_start", { objective: `completed ${stage}` });
						const runId = lastLoopState(harness).runId as string;
						active = true;
						await executeTool(harness, "loop_delegate", { name: "delegate", task: "publish completed structured terminal" });
						await waitUntil(() => injections === 1, `${stage} was not injected`);
						await tick();
						const typed = allFieldsTypedFacts(childId);
						const lifecycle = childLifecycleEvents(childId);
						const terminal = allFieldsCompletedTerminal(childId);
						const stores = await childEventsInStores(cwd, runId, harness, childId);
						assert.equal(injections, 1);
						assert.deepEqual(
							stores.canonical,
							stage === "canonical write" ? [...lifecycle, ...typed] : [...lifecycle, ...typed, terminal],
						);
						assert.deepEqual(stores.mirror, [...lifecycle, ...typed]);
						await assertPoisonedLoopPauseLeavesOriginUnchanged(cwd, runId, harness);
						assert.deepEqual(await childEventsInStores(cwd, runId, harness, childId), stores);
						assert.deepEqual(unhandled, []);
					});
				});
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
		executed += 1;
	}
	assert.equal(executed, 3);
});

test("structured authority remains on originating run after clear/start B", async () => {
	await withTemporaryCwd(async (cwd) => {
		const settlement = deferred();
		const refsCompletion = deferred<readonly string[]>();
		const structuredCompletion = deferred<ReturnType<typeof allFieldsStructuredResult>>();
		let childId = "";
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: { async launch(request) {
			childId = request.childRunId;
			return {
				pid: process.pid + 1,
				artifactRefs: refsCompletion.promise,
				structuredResult: structuredCompletion.promise,
				settled: settlement.promise,
			};
		} } });
		process.on("unhandledRejection", onUnhandled);
		try {
			await executeTool(harness, "loop_start", { objective: "Run A owns late structured authority" });
			const runA = lastLoopState(harness).runId as string;
			await executeTool(harness, "loop_delegate", { name: "delegate", task: "Publish all structured facts late" });
			const refs = childRuntimeRefs(childId);
			await assertChildEventsInStores(cwd, runA, harness, childId, [...childLifecycleEvents(childId)], "A before clear");

			await executeTool(harness, "loop_clear", {});
			await executeTool(harness, "loop_start", { objective: "Run B remains uncontaminated" });
			const runB = lastLoopState(harness).runId as string;
			assert.notEqual(runB, runA);
			const bBefore = await originRunPublications(cwd, runB, harness);
			const bSequenceBefore = lastLoopState(harness).sequence;

			settlement.resolve();
			refsCompletion.resolve(refs);
			structuredCompletion.resolve(allFieldsStructuredResult(childId, [refs[2]!]));
			await waitUntil(() => loopEvents(harness).some((event) => event.runId === runA
				&& event.kind === "delegation.updated"
				&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
				&& (event.payload as { status?: unknown }).status === "completed"), "late A terminal was not published");

			const expected = [...childLifecycleEvents(childId), ...allFieldsTypedFacts(childId), allFieldsCompletedTerminal(childId, refs)];
			await assertChildEventsInStores(cwd, runA, harness, childId, expected, "late A structured authority");
			const bAfter = await originRunPublications(cwd, runB, harness);
			assert.deepEqual(bAfter.canonical, bBefore.canonical, "late A publication must not change B canonical events");
			assert.deepEqual(bAfter.loopEvents, bBefore.loopEvents, "late A publication must not change B mirrors");
			assert.deepEqual(bAfter.loopStates, bBefore.loopStates, "late A publication must not change B snapshots");
			assert.equal(lastLoopState(harness).sequence, bSequenceBefore, "late A publication must not advance B sequence");
			const bSurfaces = JSON.stringify({
				...bAfter,
				status: resultText(await executeTool(harness, "loop_status", {})),
				prompt: await requiredHandler(harness, "before_agent_start", "B prompt hook required")({ type: "before_agent_start" }, harness.ctx),
			});
			for (const sentinel of [childId, ...refs, "structured summary", "src/a.ts", "npm test", "APPROVE", "minor", "blocked", "complete"]) {
				assert.equal(bSurfaces.includes(sentinel), false, `B surfaces must not contain A sentinel ${sentinel}`);
			}
			await tick();
			assert.deepEqual(unhandled, []);
		} finally {
			settlement.resolve();
			refsCompletion.resolve([]);
			structuredCompletion.resolve(undefined as never);
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("structured adaptation resists post-plan mutation", async () => {
	await withTemporaryCwd(async (cwd) => {
		const settlement = deferred();
		const refsCompletion = deferred<readonly string[]>();
		const structuredCompletion = deferred<ChildStructuredResult>();
		let childId = "";
		let releaseWrite!: () => void;
		const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
		let gateHits = 0;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		const runtimeRefs: string[] = [];
		const result: {
			summary: string; artifactRefs: string[]; filesChanged: string[];
			validations: Array<{ command: string; outcome: string }>;
			review: { verdict: string; findings: string[] }; nits: string[]; blockers: string[];
			confidence: number; classification: string;
		} = {
			summary: "before summary", artifactRefs: [], filesChanged: ["before-workspace.ts"],
			validations: [{ command: "before-command", outcome: "before-outcome" }],
			review: { verdict: "BEFORE_VERDICT", findings: ["before-finding"] }, nits: ["before-nit"], blockers: ["before-blocker"],
			confidence: 0.25, classification: "before-classification",
		};
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: { async launch(request) {
			childId = request.childRunId;
			runtimeRefs.push(`children/${childId}/stdout.bin`, `children/${childId}/stderr.bin`, `children/${childId}/structured.bin`);
			result.artifactRefs.push(runtimeRefs[2]!);
			return { pid: process.pid + 1, artifactRefs: refsCompletion.promise, structuredResult: structuredCompletion.promise, settled: settlement.promise };
		} } });
		process.on("unhandledRejection", onUnhandled);
		try {
			await withFileHandleMethod("writeFile", (original) => async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
				const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				if (text.includes('"kind":"workspace.changed"') && text.includes("before-workspace.ts")) {
					gateHits += 1;
					await writeReleased;
				}
				return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
			}, async () => {
				await executeTool(harness, "loop_start", { objective: "Defend planned structured authority" });
				const runId = lastLoopState(harness).runId as string;
				await executeTool(harness, "loop_delegate", { name: "delegate", task: "Publish mutable all-fields result" });
				const preRefs = [...runtimeRefs];
				const expected: Array<readonly [unknown, unknown]> = [
					...childLifecycleEvents(childId),
					["workspace.changed", { childId, files: ["before-workspace.ts"] }],
					["validation.completed", { childId, command: "before-command", outcome: "before-outcome" }],
					["review.completed", { childId, verdict: "BEFORE_VERDICT", findings: ["before-finding"] }],
					["nit.recorded", { childId, message: "before-nit" }],
					["blocker.raised", { childId, message: "before-blocker" }],
					["delegation.updated", { childId, status: "completed", artifactRefs: preRefs, summary: "before summary", confidence: 0.25, classification: "before-classification", resultArtifactRefs: [preRefs[2]!] }],
				];
				settlement.resolve();
				refsCompletion.resolve(runtimeRefs);
				structuredCompletion.resolve(result as ChildStructuredResult);
				await waitUntil(() => gateHits === 1, "canonical workspace append did not enter mutation gate");
				assert.equal(gateHits, 1, "only the canonical pre-mutation workspace append may enter the gate");
				const mutate = (tag: string) => {
					runtimeRefs.splice(0, runtimeRefs.length, `${tag}-runtime`);
					result.artifactRefs.splice(0, result.artifactRefs.length, `${tag}-result`);
					result.filesChanged.splice(0, result.filesChanged.length, `${tag}-file`);
					result.validations[0]!.command = `${tag}-command`; result.validations[0]!.outcome = `${tag}-outcome`;
					result.validations.splice(0, result.validations.length, { command: `${tag}-replacement-command`, outcome: `${tag}-replacement-outcome` });
					result.review.verdict = `${tag}-verdict`; result.review.findings.splice(0, result.review.findings.length, `${tag}-finding`);
					result.nits.splice(0, result.nits.length, `${tag}-nit`); result.blockers.splice(0, result.blockers.length, `${tag}-blocker`);
					result.summary = `${tag}-summary`; result.confidence = 0.75; result.classification = `${tag}-classification`;
				};
				mutate("first-mutation");
				releaseWrite();
				await waitUntil(() => loopEvents(harness).some((event) => event.runId === runId && event.kind === "delegation.updated"
					&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
					&& (event.payload as { status?: unknown }).status === "completed"), "mutated child terminal was not published");
				await assertChildEventsInStores(cwd, runId, harness, childId, expected, "post-plan mutation must not rewrite authority");
				assert.equal(gateHits, 1, "the mutation gate must block exactly one canonical workspace append");
				mutate("second-mutation");
				await tick();
				await assertChildEventsInStores(cwd, runId, harness, childId, expected, "post-terminal mutation must not rewrite authority");
				const persisted = JSON.stringify({ canonical: await readOriginCanonicalEvents(cwd, runId), mirrors: loopEvents(harness).filter((event) => event.runId === runId) });
				assert.equal(/first-mutation|second-mutation/.test(persisted), false, "no mutation sentinel may become journal authority");
				assert.deepEqual(unhandled, []);
			});
		} finally {
			releaseWrite();
			settlement.resolve();
			refsCompletion.resolve([]);
			structuredCompletion.resolve(undefined as never);
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("structured authority publishes only allowlisted fields", async () => {
	await withTemporaryCwd(async (cwd) => {
		// Distinct positive/negative tokens keep Matrix F non-vacuous across stores and surfaces.
		const forbiddenAuthorityTokens = [
			"FORBIDDEN_CALLER_PROSE",
			"FORBIDDEN_NESTED_VALUE",
			"FORBIDDEN_REVIEW_VALUE",
			"FORBIDDEN_RAW_WRAPPER",
			"FORBIDDEN_FINAL_PROSE",
			"unknownTopLevelKey",
			"unknownNestedKey",
			"finalLikeProse",
		] as const;
		const immediateAbsentTokens = [
			"FORBIDDEN_CALLER_PROSE",
			"artifactRefs",
			"summary",
			"confidence",
			"classification",
			"resultArtifactRefs",
			"ALLOWED_SUMMARY",
			"ALLOWED_FILE",
		] as const;
		const allowedAuthorityTokens = [
			"ALLOWED_SUMMARY",
			"ALLOWED_FILE",
			"ALLOWED_COMMAND",
			"ALLOWED_OUTCOME",
			"ALLOWED_VERDICT",
			"ALLOWED_FINDING",
			"ALLOWED_NIT",
			"ALLOWED_BLOCKER",
			"ALLOWED_CLASSIFICATION",
		] as const;
		const allowedProjectionTokens = [
			"ALLOWED_SUMMARY",
			"ALLOWED_FILE",
			"ALLOWED_COMMAND",
			"ALLOWED_OUTCOME",
			"ALLOWED_VERDICT",
			"ALLOWED_FINDING",
			"ALLOWED_NIT",
			"ALLOWED_BLOCKER",
			"0.42",
			"ALLOWED_CLASSIFICATION",
		] as const;

		const settlement = deferred();
		const refsCompletion = deferred<readonly string[]>();
		const structuredCompletion = deferred<ChildStructuredResult>();
		let childId = "";
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		const harness = createHarness({ cwd });
		installLoop(harness, { delegateExecutor: { async launch(request) {
			childId = request.childRunId;
			return {
				pid: process.pid + 1,
				artifactRefs: refsCompletion.promise,
				structuredResult: structuredCompletion.promise,
				settled: settlement.promise,
			};
		} } });
		process.on("unhandledRejection", onUnhandled);
		try {
			await executeTool(harness, "loop_start", { objective: "Matrix F eligible authority" });
			const runId = lastLoopState(harness).runId as string;
			const immediate = await executeTool(harness, "loop_delegate", { name: "delegate", task: "FORBIDDEN_CALLER_PROSE" });
			assert.deepEqual(immediate.details, { childRunId: childId });
			const immediateSerialized = JSON.stringify(immediate);
			for (const absent of immediateAbsentTokens) {
				assert.equal(immediateSerialized.includes(absent), false);
			}

			const refs = [
				`children/${childId}/stdout.bin`,
				`children/${childId}/stderr.bin`,
				`children/${childId}/final.bin`,
				`children/${childId}/structured.bin`,
			];
			// Explicit cast only: extra keys must reach the adapter, not R08A validation.
			const result = {
				summary: "ALLOWED_SUMMARY",
				artifactRefs: [refs[3]],
				filesChanged: ["ALLOWED_FILE"],
				validations: [{
					command: "ALLOWED_COMMAND",
					outcome: "ALLOWED_OUTCOME",
					unknownNestedKey: "FORBIDDEN_NESTED_VALUE",
				}],
				review: {
					verdict: "ALLOWED_VERDICT",
					findings: ["ALLOWED_FINDING"],
					unknownNestedKey: "FORBIDDEN_REVIEW_VALUE",
				},
				nits: ["ALLOWED_NIT"],
				blockers: ["ALLOWED_BLOCKER"],
				confidence: 0.42,
				classification: "ALLOWED_CLASSIFICATION",
				unknownTopLevelKey: "FORBIDDEN_RAW_WRAPPER",
				finalLikeProse: "FORBIDDEN_FINAL_PROSE",
			} as unknown as ChildStructuredResult;
			settlement.resolve();
			refsCompletion.resolve(refs);
			await tick();
			await assertChildEventsInStores(
				cwd,
				runId,
				harness,
				childId,
				[...childLifecycleEvents(childId)],
				"two settled promises must not publish authority",
			);
			structuredCompletion.resolve(result);
			await waitUntil(() => loopEvents(harness).some((event) => event.runId === runId
				&& event.kind === "delegation.updated"
				&& (event.payload as { childId?: unknown; status?: unknown }).childId === childId
				&& (event.payload as { status?: unknown }).status === "completed"), "eligible terminal was not published");

			const expected: Array<readonly [unknown, unknown]> = [
				...childLifecycleEvents(childId),
				["workspace.changed", { childId, files: ["ALLOWED_FILE"] }],
				["validation.completed", { childId, command: "ALLOWED_COMMAND", outcome: "ALLOWED_OUTCOME" }],
				["review.completed", { childId, verdict: "ALLOWED_VERDICT", findings: ["ALLOWED_FINDING"] }],
				["nit.recorded", { childId, message: "ALLOWED_NIT" }],
				["blocker.raised", { childId, message: "ALLOWED_BLOCKER" }],
				["delegation.updated", {
					childId,
					status: "completed",
					artifactRefs: refs,
					summary: "ALLOWED_SUMMARY",
					confidence: 0.42,
					classification: "ALLOWED_CLASSIFICATION",
					resultArtifactRefs: [refs[3]],
				}],
			];
			// Exact payload deep equality is the payload-key allowlist for each kind.
			await assertChildEventsInStores(
				cwd,
				runId,
				harness,
				childId,
				expected,
				"canonical JSONL and loop-event mirrors must be exact",
			);
			// Authority surfaces only: canonical JSONL + customType loop-event mirrors (not loop-delegation).
			const canonical = await readOriginCanonicalEvents(cwd, runId);
			const mirrors = loopEvents(harness).filter((event) => event.runId === runId);
			for (const events of [canonical, mirrors]) {
				const serialized = JSON.stringify(events);
				for (const allowed of [...refs, ...allowedAuthorityTokens]) {
					assert.ok(serialized.includes(allowed));
				}
				for (const forbidden of forbiddenAuthorityTokens) {
					assert.equal(serialized.includes(forbidden), false, `${forbidden} must not be authority`);
				}
			}
			const status = resultText(await executeTool(harness, "loop_status", {}));
			const prompt = (await requiredHandler(harness, "before_agent_start", "prompt hook required")(
				{ type: "before_agent_start" },
				harness.ctx,
			) as { systemPrompt: string }).systemPrompt;
			for (const surface of [status, prompt]) {
				const contextStart = surface.indexOf("Loop decision context");
				assert.ok(contextStart >= 0, "projected context must be present");
				const context = surface.slice(contextStart);
				assert.ok(context.length <= 4000, "projected context must remain bounded");
				for (const allowed of [...refs, ...allowedProjectionTokens]) {
					assert.ok(context.includes(allowed), `${allowed} must appear in projected context`);
				}
				assert.match(context, new RegExp(`delegation ${childId}: completed`));
				assert.doesNotMatch(context, new RegExp(`delegation ${childId}: (started|running)`));
				for (const forbidden of forbiddenAuthorityTokens) {
					assert.equal(context.includes(forbidden), false);
				}
			}
			await tick();
			assert.deepEqual(unhandled, []);
		} finally {
			settlement.resolve();
			refsCompletion.resolve([]);
			structuredCompletion.resolve(undefined as never);
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
