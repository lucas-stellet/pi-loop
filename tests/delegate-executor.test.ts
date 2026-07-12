import assert from "node:assert/strict";
import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
	createPiDelegateExecutor,
	DelegateCancellationError,
	type DelegateLaunchRequest,
	type PiDelegateSpawn,
} from "../src/delegate-executor.ts";
import type { DelegateMetadata } from "../src/delegate-registry.ts";

type SpawnCall = {
	command: string;
	args: readonly string[];
	options: SpawnOptions;
};

const metadata: DelegateMetadata = {
	name: "trusted",
	tools: ["read", "bash"],
	systemPrompt: "trusted system prompt",
};
const hostileTask = "--leading @file ../traversal 'quote'\n$(danger); pipe | text";
const request: DelegateLaunchRequest = {
	parentRunId: "parent-1",
	childRunId: "run-1",
	cwd: "/exact/request/cwd",
	task: hostileTask,
	metadata,
};

class FakeChild extends EventEmitter {
	pid: number | undefined = 43210;
	stdin = new EventEmitter() as EventEmitter & {
		end: (input: string, callback?: () => void) => void;
		destroy: (error?: Error) => EventEmitter;
	};
	stdout = new PassThrough();
	stderr = new PassThrough();
	input: string | undefined;
	endCallback: (() => void) | undefined;
	endCalls = 0;
	stdinDestroyed = false;
	stdinDestroyCalls = 0;
	killCalls = 0;

	constructor() {
		super();
		this.on("close", () => {
			this.stdout.end();
			this.stderr.end();
		});
		this.stdin.end = (input, callback) => {
			this.endCalls += 1;
			this.input = input;
			this.endCallback = callback;
		};
		this.stdin.destroy = () => {
			this.stdinDestroyed = true;
			this.stdinDestroyCalls += 1;
			return this.stdin;
		};
	}

	deliver(): void {
		this.endCallback?.();
	}

	kill(): boolean {
		this.killCalls += 1;
		return true;
	}
}

function memoryArtifactStore() {
	return Promise.resolve({
		writeStdout: async (_content: Buffer) => {},
		writeStderr: async (_content: Buffer) => {},
		finalize: async () => [],
	});
}

function executorWith(child: FakeChild, calls: SpawnCall[] = []) {
	const spawn: PiDelegateSpawn = (command, args, options) => {
		calls.push({ command, args, options });
		return child as unknown as ChildProcess;
	};
	return { executor: createPiDelegateExecutor({ spawn, createArtifactStore: memoryArtifactStore }), calls };
}

async function oneTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await oneTurn();
	}
	throw new Error(message);
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForFileBytes(path: string, expected: Buffer): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			if ((await readFile(path)).equals(expected)) return;
		} catch {
			// The fixed artifact may not exist until the child store is ready.
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for exact artifact bytes at ${path}.`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function withHostFailureObservation(
	run: (observed: { unhandled: unknown[]; uncaught: unknown[] }) => Promise<void>,
): Promise<void> {
	const unhandled: unknown[] = [];
	const uncaught: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	const onUncaught = (error: unknown) => {
		uncaught.push(error);
	};
	process.on("unhandledRejection", onUnhandled);
	process.on("uncaughtExceptionMonitor", onUncaught);
	try {
		await run({ unhandled, uncaught });
		await oneTurn();
		assert.deepEqual(unhandled, []);
		assert.deepEqual(uncaught, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		process.off("uncaughtExceptionMonitor", onUncaught);
	}
}

async function assertPreConfirmationFirstWins(options: {
	induce: (child: FakeChild) => Error;
	expectedEndCallsAfterFailure: number;
	emitLateSpawn: boolean;
}): Promise<void> {
	const child = new FakeChild();
	const launching = executorWith(child).executor.launch(request);
	const outcomes: Array<"resolved" | "rejected"> = [];
	void launching.then(
		() => {
			outcomes.push("resolved");
		},
		() => {
			outcomes.push("rejected");
		},
	);

	await withHostFailureObservation(async () => {
		const expected = options.induce(child);
		await assert.rejects(launching, (error: Error) => error === expected || error.message === expected.message);
		const endCallsAfterFailure = child.endCalls;
		assert.equal(endCallsAfterFailure, options.expectedEndCallsAfterFailure);

		if (options.emitLateSpawn) {
			child.emit("spawn");
		}
		child.deliver();
		assert.doesNotThrow(() => {
			child.emit("error", new Error("late child error"));
			child.stdin.emit("error", new Error("late stdin error"));
			child.emit("close", 1, null);
			child.emit("spawn");
			child.emit("error", new Error("duplicate late child error"));
			child.stdin.emit("error", new Error("duplicate late stdin error"));
			child.emit("close", 0, null);
		});

		await oneTurn();
		assert.deepEqual(outcomes, ["rejected"]);
		assert.equal(
			child.endCalls,
			endCallsAfterFailure,
			"late spawn/delivery must not restart stdin delivery after pre-confirmation failure",
		);
	});
}

test("uses the fixed pi invocation and sends hostile caller text as exact stdin bytes only", async () => {
	const child = new FakeChild();
	const { executor, calls } = executorWith(child);
	const launching = executor.launch(request);
	void launching.catch(() => {});

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		command: "pi",
		args: [
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--tools",
			"read,bash",
			"--append-system-prompt",
			"trusted system prompt",
		],
		options: { cwd: request.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] },
	});
	assert.equal(calls[0].command.includes(hostileTask), false);
	assert.equal(calls[0].args.some((arg) => arg.includes(hostileTask)), false);

	child.emit("spawn");
	child.deliver();
	const handle = await launching;
	assert.equal(child.input, hostileTask);
	child.emit("close", 0, null);
	await handle.settled;
});

test("waits for spawn, numeric pid, and stdin delivery, but not child close", async () => {
	const child = new FakeChild();
	const { executor } = executorWith(child);
	const launching = executor.launch(request);
	void launching.catch(() => {});
	let resolved = false;
	void launching.then(
		() => {
			resolved = true;
		},
		() => {},
	);
	await oneTurn();
	assert.equal(resolved, false);

	child.pid = undefined;
	child.emit("spawn");
	await assert.rejects(launching, /process id/);

	const ready = new FakeChild();
	const second = executorWith(ready).executor.launch(request);
	void second.catch(() => {});
	ready.emit("spawn");
	await oneTurn();
	let delivered = false;
	void second.then(() => {
		delivered = true;
	});
	assert.equal(delivered, false);
	ready.deliver();
	const handle = await second;
	let settled = false;
	void handle.settled.then(() => {
		settled = true;
	});
	await oneTurn();
	assert.equal(settled, false);
	ready.emit("close", 0, null);
	await handle.settled;
});

test("rejects launch with ENOENT when the requested pi executable is missing", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-loop-delegate-enoent-"));
	const missingExecutable = join(tempDir, "definitely-missing-pi-binary");
	try {
		await withHostFailureObservation(async () => {
			const spawn: PiDelegateSpawn = (command, args, options) => {
				assert.equal(command, "pi");
				assert.equal(options.shell, false);
				return realSpawn(missingExecutable, [...args], {
					cwd: tempDir,
					shell: false,
					stdio: options.stdio,
				});
			};
			const executor = createPiDelegateExecutor({ spawn });
			await assert.rejects(
				executor.launch({ ...request, cwd: tempDir }),
				(error: NodeJS.ErrnoException) => {
					assert.equal(error.code, "ENOENT");
					return true;
				},
			);
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("launches a provider-free real child with a distinct live PID and reaps it", async () => {
	let actual: ChildProcess | undefined;
	let ready: Promise<unknown[]> | undefined;
	let closed: Promise<unknown[]> | undefined;
	const spawn: PiDelegateSpawn = (command, args, options) => {
		assert.equal(command, "pi");
		assert.deepEqual(args.slice(0, 4), ["--mode", "json", "--print", "--no-session"]);
		assert.equal(options.shell, false);
		actual = realSpawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); process.stdin.resume(); setInterval(() => {}, 1000)"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		ready = once(actual.stdout!, "data");
		// Install close waiter immediately so close cannot race past cleanup.
		closed = once(actual, "close");
		return actual;
	};
	const executor = createPiDelegateExecutor({ spawn, createArtifactStore: memoryArtifactStore });
	let handle: Awaited<ReturnType<typeof executor.launch>> | undefined;
	try {
		handle = await executor.launch(request);
		await withTimeout(ready!, 5_000, "timed out waiting for real child readiness");
		assert.equal(typeof handle.pid, "number");
		assert.notEqual(handle.pid, process.pid);
		process.kill(handle.pid, 0);
		process.kill(handle.pid, "SIGTERM");
		await withTimeout(closed!, 5_000, "timed out waiting to reap real child process");
		assert.equal(actual?.exitCode, 0);
		assert.equal(actual?.signalCode, null);
		await handle.settled;
	} finally {
		if (actual && actual.exitCode === null && actual.signalCode === null) actual.kill("SIGKILL");
		if (closed) await withTimeout(closed, 5_000, "timed out waiting to reap real child process");
		await handle?.settled.catch(() => {});
	}
});

test("drains a real child’s high-volume binary stdout and stderr into its fixed artifacts", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-loop-delegate-artifacts-"));
	const parentRunId = "parent-1";
	const childRunId = "child-1";
	const stdout = Buffer.alloc(256 * 1024, 0xff);
	const stderr = Buffer.alloc(256 * 1024, 0xfe);
	stdout[0] = 0;
	stderr[0] = 0;
	let actual: ChildProcess | undefined;
	let closed: Promise<unknown[]> | undefined;
	let spawnOptions: SpawnOptions | undefined;
	const spawn: PiDelegateSpawn = (_command, _args, options) => {
		spawnOptions = options;
		actual = realSpawn(
			process.execPath,
			[
				"-e",
				`const { once } = require('node:events');
async function writeAll(stream, content) { if (!stream.write(content)) await once(stream, 'drain'); }
(async () => {
	const stdout = Buffer.alloc(256 * 1024, 0xff); stdout[0] = 0;
	const stderr = Buffer.alloc(256 * 1024, 0xfe); stderr[0] = 0;
	await writeAll(process.stdout, stdout);
	await writeAll(process.stderr, stderr);
	const input = [];
	process.stdin.on('data', (chunk) => input.push(chunk));
	process.stdin.on('end', () => { void writeAll(process.stdout, Buffer.concat(input)); });
	setTimeout(() => process.stdin.resume(), 100);
})();`,
			],
			{ cwd: tempDir, shell: false, stdio: options.stdio },
		);
		closed = once(actual, "close");
		return actual;
	};
	const executor = createPiDelegateExecutor({ spawn });
	let handle: Awaited<ReturnType<typeof executor.launch>> | undefined;
	try {
		handle = await executor.launch({
			...request,
			cwd: tempDir,
			childRunId,
			parentRunId,
		});
		assert.notEqual(handle.pid, process.pid);
		assert.equal(actual?.exitCode, null, "launch must return before the child closes");
		await withTimeout(handle.settled, 5_000, "timed out draining real child output");
		assert.deepEqual(
			await readFile(join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "stdout.bin")),
			Buffer.concat([stdout, Buffer.from(request.task)]),
		);
		assert.deepEqual(
			await readFile(join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "stderr.bin")),
			stderr,
		);
		assert.deepEqual(spawnOptions?.stdio, ["pipe", "pipe", "pipe"]);
	} finally {
		if (actual && actual.exitCode === null && actual.signalCode === null) actual.kill("SIGKILL");
		if (closed) await withTimeout(closed, 5_000, "timed out waiting to reap real child process");
		await handle?.settled.catch(() => {});
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("retains documented Pi final assistant output as a final artifact", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-loop-delegate-final-"));
	const child = new FakeChild();
	const parentRunId = "parent-final";
	const childRunId = "child-final";
	const stdout = Buffer.from(
		'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"FINAL_SENTINEL"}]}}\n',
		"utf8",
	);
	const executor = createPiDelegateExecutor({
		spawn: () => child as unknown as ChildProcess,
	});
	try {
		const launching = executor.launch({ ...request, cwd: tempDir, parentRunId, childRunId });
		child.emit("spawn");
		child.deliver();
		const handle = await launching;

		child.stdout.write(stdout.subarray(0, 23));
		child.stdout.end(stdout.subarray(23));
		child.stderr.end();
		child.emit("close", 0, null);

		const artifactRefs = await handle.artifactRefs;
		assert.deepEqual(
			await readFile(join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "stdout.bin")),
			stdout,
		);
		assert.deepEqual(artifactRefs, [
			"children/child-final/stdout.bin",
			"children/child-final/stderr.bin",
			"children/child-final/final.bin",
		]);
		assert.deepEqual(
			await readFile(join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "final.bin")),
			Buffer.from("FINAL_SENTINEL", "utf8"),
		);
		await handle.settled;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("retains final output for generic failure and ignores documented-looking stderr", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-loop-delegate-final-failure-"));
	const child = new FakeChild();
	const parentRunId = "parent-final-failure";
	const childRunId = "child-final-failure";
	const finalText = '{"summary":"opaque only","files":["not-authority.ts"]}';
	const stdout = Buffer.from(`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: finalText }] },
	})}\n`);
	const stderr = Buffer.from(`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "STDERR_MUST_NOT_WIN" }] },
	})}\n`);
	const executor = createPiDelegateExecutor({ spawn: () => child as unknown as ChildProcess });
	try {
		const launching = executor.launch({ ...request, cwd: tempDir, parentRunId, childRunId });
		child.emit("spawn");
		child.deliver();
		const handle = await launching;
		child.stdout.end(stdout);
		child.stderr.end(stderr);
		assert.deepEqual(await handle.artifactRefs, [
			"children/child-final-failure/stdout.bin",
			"children/child-final-failure/stderr.bin",
			"children/child-final-failure/final.bin",
		]);

		const runtimeError = new Error("generic post-output failure");
		child.emit("error", runtimeError);
		child.emit("close", 1, null);
		await assert.rejects(handle.settled, (error: unknown) => error === runtimeError);
		const directory = join(tempDir, ".pi", "loop", parentRunId, "children", childRunId);
		assert.deepEqual(await readFile(join(directory, "stdout.bin")), stdout);
		assert.deepEqual(await readFile(join(directory, "stderr.bin")), stderr);
		assert.deepEqual(await readFile(join(directory, "final.bin")), Buffer.from(finalText));
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("selected final artifact failures remain fail closed until actual child close", async () => {
	const child = new FakeChild();
	const originError = new Error("final artifact unavailable");
	let finalizeCalls = 0;
	let capturedFinal: Buffer | undefined;
	const executor = createPiDelegateExecutor({
		spawn: () => child as unknown as ChildProcess,
		createArtifactStore: async () => ({
			writeStdout: async () => {},
			writeStderr: async () => {},
			finalize: async (output) => {
				finalizeCalls += 1;
				capturedFinal = output?.final;
				throw originError;
			},
		}),
	});
	const launching = executor.launch(request);
	child.emit("spawn");
	child.deliver();
	const handle = await launching;
	const line = Buffer.from(`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "selected before failure" }] },
	})}\n`);

	await withHostFailureObservation(async () => {
		child.stdout.end(line);
		child.stderr.end();
		await assert.rejects(handle.artifactRefs, (error: unknown) => error === originError);
		assert.equal(finalizeCalls, 1);
		assert.deepEqual(capturedFinal, Buffer.from("selected before failure"));
		let settled = false;
		void handle.settled.catch(() => { settled = true; });
		await oneTurn();
		assert.equal(settled, false);
		child.emit("close", null, "SIGTERM");
		await assert.rejects(handle.settled, (error: unknown) => error === originError);
	});
});

test("backpressures a bounded producer while an artifact write is pending", async () => {
	const child = new FakeChild();
	const firstWrite = deferred();
	const firstWriteEntered = deferred();
	const factoryCalls: unknown[] = [];
	const stdoutWrites: Buffer[] = [];
	let finalizeCalls = 0;
	const refs = ["children/run-1/stdout.bin", "children/run-1/stderr.bin"];
	const executor = createPiDelegateExecutor({
		spawn: () => child as unknown as ChildProcess,
		createArtifactStore: async (input) => {
			factoryCalls.push(input);
			return {
				writeStdout: async (content) => {
					stdoutWrites.push(Buffer.from(content));
					if (stdoutWrites.length === 1) {
						firstWriteEntered.resolve();
						await firstWrite.promise;
					}
				},
				writeStderr: async () => {},
				finalize: async () => {
					finalizeCalls += 1;
					return refs;
				},
			};
		},
	});
	const launching = executor.launch(request);
	child.emit("spawn");
	child.deliver();
	const handle = await launching;

	let produced = 0;
	const chunks = Array.from({ length: 100 }, () => Buffer.alloc(64 * 1024, 0xa5));
	const producer = (async () => {
		for (const chunk of chunks) {
			produced += 1;
			if (!child.stdout.write(chunk)) await once(child.stdout, "drain");
		}
		child.stdout.end();
	})();
	child.stderr.end();
	await firstWriteEntered.promise;
	await oneTurn();
	assert.equal(stdoutWrites.length, 1, "the sink must not invoke a second store write while the first is pending");
	assert.ok(produced < chunks.length, "a backpressure-aware producer must pause instead of freely emitting all output");
	assert.equal(finalizeCalls, 0);
	assert.deepEqual(factoryCalls, [{ cwd: request.cwd, parentRunId: request.parentRunId, childRunId: request.childRunId }]);
	assert.doesNotMatch(JSON.stringify(factoryCalls), /leading|traversal|danger/);

	firstWrite.resolve();
	await producer;
	child.emit("close", 0, null);
	assert.deepEqual(await handle.artifactRefs, refs);
	await handle.settled;
	assert.equal(stdoutWrites.length, chunks.length);
	assert.equal(finalizeCalls, 1);
});

test("waits for delayed stream writes and one gated finalize before exposing refs or settlement", async () => {
	const child = new FakeChild();
	const writeEntered = deferred();
	const releaseWrite = deferred();
	const finalizeEntered = deferred();
	const releaseFinalize = deferred();
	const order: string[] = [];
	const refs = ["children/run-1/stdout.bin", "children/run-1/stderr.bin"];
	let finalizeCalls = 0;
	const executor = createPiDelegateExecutor({
		spawn: () => child as unknown as ChildProcess,
		createArtifactStore: async () => ({
			writeStdout: async () => {
				order.push("stdout write start");
				writeEntered.resolve();
				await releaseWrite.promise;
				order.push("stdout write end");
			},
			writeStderr: async () => {
				order.push("stderr write end");
			},
			finalize: async () => {
				finalizeCalls += 1;
				order.push("finalize start");
				finalizeEntered.resolve();
				await releaseFinalize.promise;
				order.push("finalize end");
				return refs;
			},
		}),
	});
	const launching = executor.launch(request);
	child.emit("spawn");
	child.deliver();
	const handle = await launching;
	let refsOutcome: "resolved" | "rejected" | undefined;
	let settledOutcome: "resolved" | "rejected" | undefined;
	let refsCallbacks = 0;
	let settledCallbacks = 0;
	void handle.artifactRefs.then(
		() => { refsCallbacks += 1; refsOutcome = "resolved"; },
		() => { refsCallbacks += 1; refsOutcome = "rejected"; },
	);
	void handle.settled.then(
		() => { settledCallbacks += 1; settledOutcome = "resolved"; },
		() => { settledCallbacks += 1; settledOutcome = "rejected"; },
	);

	child.stdout.end(Buffer.from("stdout"));
	child.stderr.end(Buffer.from("stderr"));
	await writeEntered.promise;
	child.emit("close", 0, null);
	await oneTurn();
	assert.equal(refsOutcome, undefined);
	assert.equal(settledOutcome, undefined);
	assert.equal(finalizeCalls, 0);

	releaseWrite.resolve();
	await finalizeEntered.promise;
	assert.equal(finalizeCalls, 1);
	assert.ok(order.indexOf("finalize start") > order.indexOf("stdout write end"));
	assert.ok(order.indexOf("finalize start") > order.indexOf("stderr write end"));
	assert.equal(refsOutcome, undefined);
	assert.equal(settledOutcome, undefined);

	releaseFinalize.resolve();
	assert.deepEqual(await handle.artifactRefs, refs);
	await handle.settled;
	assert.deepEqual(order.at(-1), "finalize end");
	assert.equal(refsCallbacks, 1);
	assert.equal(settledCallbacks, 1);

	child.emit("spawn");
	child.deliver();
	child.stdout.end();
	child.stderr.end();
	child.emit("close", 0, null);
	await oneTurn();
	assert.equal(finalizeCalls, 1);
	assert.equal(refsCallbacks, 1);
	assert.equal(settledCallbacks, 1);
});

test("retains exact stream artifacts for a real signal-cancelled child", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-loop-delegate-cancel-artifacts-"));
	const parentRunId = "parent-cancel";
	const childRunId = "child-cancel";
	const finalText = "cancelled final sentinel";
	const stdout = Buffer.from(`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: finalText }] },
	})}\n`, "utf8");
	const stderr = Buffer.from([0xfe, 0x00, 0x42]);
	const stdoutPath = join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "stdout.bin");
	const stderrPath = join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "stderr.bin");
	const finalPath = join(tempDir, ".pi", "loop", parentRunId, "children", childRunId, "final.bin");
	let actual: ChildProcess | undefined;
	let closed: Promise<unknown[]> | undefined;
	const spawn: PiDelegateSpawn = (_command, _args, options) => {
		actual = realSpawn(process.execPath, [
			"-e",
			`const { once } = require('node:events');
async function writeAll(stream, bytes) { if (!stream.write(Buffer.from(bytes, 'base64'))) await once(stream, 'drain'); }
(async () => {
	await writeAll(process.stdout, '${stdout.toString("base64")}');
	await writeAll(process.stderr, '${stderr.toString("base64")}');
	process.stdin.resume();
	setInterval(() => {}, 1000);
})();`,
		], { cwd: tempDir, shell: false, stdio: options.stdio });
		closed = once(actual, "close");
		return actual;
	};
	const executor = createPiDelegateExecutor({ spawn });
	let handle: Awaited<ReturnType<typeof executor.launch>> | undefined;
	try {
		handle = await executor.launch({ ...request, cwd: tempDir, parentRunId, childRunId });
		assert.notEqual(handle.pid, process.pid);
		await Promise.all([waitForFileBytes(stdoutPath, stdout), waitForFileBytes(stderrPath, stderr)]);
		process.kill(handle.pid, "SIGTERM");
		assert.deepEqual(await handle.artifactRefs, [
			"children/child-cancel/stdout.bin",
			"children/child-cancel/stderr.bin",
			"children/child-cancel/final.bin",
		]);
		await assert.rejects(handle.settled, (error: unknown) => {
			assert.ok(error instanceof DelegateCancellationError);
			assert.equal(error.signal, "SIGTERM");
			return true;
		});
		assert.deepEqual(await readFile(stdoutPath), stdout);
		assert.deepEqual(await readFile(stderrPath), stderr);
		assert.deepEqual(await readFile(finalPath), Buffer.from(finalText));
		await withTimeout(closed!, 5_000, "timed out waiting to reap signal-cancelled child");
		assert.equal(actual?.signalCode, "SIGTERM");
	} finally {
		if (actual && actual.exitCode === null && actual.signalCode === null) actual.kill("SIGKILL");
		if (closed) await withTimeout(closed, 5_000, "timed out waiting to reap signal-cancelled child");
		await handle?.settled.catch(() => {});
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("rejects launch with the originating pre-confirmation artifact failure", async () => {
	const child = new FakeChild();
	const originError = new Error("artifact store unavailable before launch confirmation");
	const executor = createPiDelegateExecutor({
		spawn: () => child as unknown as ChildProcess,
		createArtifactStore: () => Promise.reject(originError),
	});
	const launching = executor.launch(request);

	await assert.rejects(
		withTimeout(launching, 100, "launch did not reject after the artifact failure"),
		(error: unknown) => error === originError,
	);

	child.emit("spawn");
	child.deliver();
	child.emit("close", 1, null);
	await assert.rejects(launching, (error: unknown) => error === originError);
	assert.equal(child.endCalls, 0, "late spawn must not begin stdin delivery after artifact failure");
});

test("rejects launch for pre-confirmation child, stdin, and close failures without late-event reversal", async () => {
	await assertPreConfirmationFirstWins({
		induce: (child) => {
			const error = new Error("before spawn");
			child.emit("error", error);
			return error;
		},
		expectedEndCallsAfterFailure: 0,
		emitLateSpawn: true,
	});

	await assertPreConfirmationFirstWins({
		induce: (child) => {
			const error = new Error("EPIPE before delivery callback");
			child.emit("spawn");
			child.stdin.emit("error", error);
			return error;
		},
		expectedEndCallsAfterFailure: 1,
		emitLateSpawn: true,
	});

	await assertPreConfirmationFirstWins({
		induce: (child) => {
			const error = new Error("Pi child closed before launch confirmation.");
			child.emit("close", 1, null);
			return error;
		},
		expectedEndCallsAfterFailure: 0,
		emitLateSpawn: true,
	});
});

test("gates post-confirmation output failures on actual child close", async () => {
	for (const failure of ["stdout readable", "stderr readable", "store write", "store finalize"] as const) {
		const child = new FakeChild();
		const originError = new Error(`${failure} failure`);
		let finalizeCalls = 0;
		const executor = createPiDelegateExecutor({
			spawn: () => child as unknown as ChildProcess,
			createArtifactStore: async () => ({
				writeStdout: async () => {
					if (failure === "store write") throw originError;
				},
				writeStderr: async () => {},
				finalize: async () => {
					finalizeCalls += 1;
					if (failure === "store finalize") throw originError;
					return [];
				},
			}),
		});
		const launching = executor.launch(request);
		let launchCallbacks = 0;
		void launching.then(
			() => {
				launchCallbacks += 1;
			},
			() => {
				launchCallbacks += 1;
			},
		);

		await withHostFailureObservation(async () => {
			child.emit("spawn");
			child.deliver();
			const handle = await launching;
			assert.equal(launchCallbacks, 1, `${failure}: launch must confirm before failure injection`);

			let settledCallbacks = 0;
			let settledOutcome: "resolved" | "rejected" | undefined;
			void handle.settled.then(
				() => {
					settledCallbacks += 1;
					settledOutcome = "resolved";
				},
				() => {
					settledCallbacks += 1;
					settledOutcome = "rejected";
				},
			);

			if (failure === "stdout readable") child.stdout.destroy(originError);
			if (failure === "stderr readable") child.stderr.destroy(originError);
			if (failure === "store write") child.stdout.write(Buffer.from("write failure"));
			if (failure === "store finalize") {
				child.stdout.end();
				child.stderr.end();
			}

			await assert.rejects(handle.artifactRefs, (error: unknown) => error === originError);
			await waitFor(() => child.killCalls === 1, `${failure}: cleanup did not request kill`);
			assert.equal(child.killCalls, 1, `${failure}: cleanup must run once`);
			assert.equal(child.stdout.destroyed, true, `${failure}: stdout must be destroyed`);
			assert.equal(child.stderr.destroyed, true, `${failure}: stderr must be destroyed`);
			assert.equal(child.stdinDestroyed, true, `${failure}: stdin must be destroyed`);
			assert.equal(finalizeCalls, failure === "store finalize" ? 1 : 0);

			await oneTurn();
			assert.equal(settledOutcome, undefined, `${failure}: settled must wait for child close`);

			child.emit("close", null, "SIGTERM");
			await assert.rejects(handle.settled, (error: unknown) => error === originError);
			assert.equal(settledCallbacks, 1, `${failure}: settlement must run once`);

			assert.doesNotThrow(() => {
				child.stdout.destroy(new Error("late stdout error"));
				child.stderr.destroy(new Error("late stderr error"));
				child.emit("error", new Error("late child error"));
				child.stdin.emit("error", new Error("late stdin error"));
				child.emit("spawn");
				child.deliver();
				child.emit("close", null, "SIGTERM");
			});
			await oneTurn();
			assert.equal(child.killCalls, 1, `${failure}: late events must not repeat cleanup`);
			assert.equal(finalizeCalls, failure === "store finalize" ? 1 : 0);
			assert.equal(launchCallbacks, 1, `${failure}: late events must not re-settle launch`);
			assert.equal(settledCallbacks, 1, `${failure}: late events must not re-settle handle`);
		});
	}
});

test("routes post-confirmation stdin and child errors to settled without uncaught errors or unhandled rejection", async () => {
	for (const emitFailure of [
		(child: FakeChild) => child.stdin.emit("error", new Error("EPIPE after launch")),
		(child: FakeChild) => child.emit("error", new Error("child after launch")),
	]) {
		const child = new FakeChild();
		const launching = executorWith(child).executor.launch(request);
		void launching.catch(() => {});
		child.emit("spawn");
		child.deliver();
		const handle = await launching;
		const unhandled: unknown[] = [];
		const observe = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", observe);
		try {
			emitFailure(child);
			await oneTurn();
			assert.deepEqual(unhandled, []);
			child.emit("close", 1, null);
			await assert.rejects(handle.settled);
		} finally {
			process.off("unhandledRejection", observe);
		}
	}
});

test("settles once across duplicate spawn, delivery, error, and close races", async () => {
	const child = new FakeChild();
	const launching = executorWith(child).executor.launch(request);
	void launching.catch(() => {});
	child.emit("spawn");
	child.emit("spawn");
	assert.equal(child.endCalls, 1, "duplicate spawn must not restart stdin delivery");
	child.deliver();
	child.deliver();
	const handle = await launching;
	child.emit("error", new Error("first failure"));
	child.emit("close", 1, null);
	child.stdin.emit("error", new Error("later failure"));
	await assert.rejects(handle.settled, /first failure/);
});
