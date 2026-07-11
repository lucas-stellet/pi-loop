import assert from "node:assert/strict";
import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createPiDelegateExecutor,
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
	childRunId: "run-1",
	cwd: "/exact/request/cwd",
	task: hostileTask,
	metadata,
};

class FakeChild extends EventEmitter {
	pid: number | undefined = 43210;
	stdin = new EventEmitter() as EventEmitter & {
		end: (input: string, callback?: () => void) => void;
	};
	input: string | undefined;
	endCallback: (() => void) | undefined;
	endCalls = 0;

	constructor() {
		super();
		this.stdin.end = (input, callback) => {
			this.endCalls += 1;
			this.input = input;
			this.endCallback = callback;
		};
	}

	deliver(): void {
		this.endCallback?.();
	}
}

function executorWith(child: FakeChild, calls: SpawnCall[] = []) {
	const spawn: PiDelegateSpawn = (command, args, options) => {
		calls.push({ command, args, options });
		return child as unknown as ChildProcess;
	};
	return { executor: createPiDelegateExecutor({ spawn }), calls };
}

async function oneTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
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
			child.emit("close", 1);
			child.emit("spawn");
			child.emit("error", new Error("duplicate late child error"));
			child.stdin.emit("error", new Error("duplicate late stdin error"));
			child.emit("close", 0);
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
		options: { cwd: request.cwd, shell: false, stdio: ["pipe", "ignore", "ignore"] },
	});
	assert.equal(calls[0].command.includes(hostileTask), false);
	assert.equal(calls[0].args.some((arg) => arg.includes(hostileTask)), false);

	child.emit("spawn");
	child.deliver();
	const handle = await launching;
	assert.equal(child.input, hostileTask);
	child.emit("close");
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
	ready.emit("close");
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
					stdio: ["pipe", "ignore", "ignore"],
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
	let closed: Promise<unknown[]> | undefined;
	const spawn: PiDelegateSpawn = (command, args, options) => {
		assert.equal(command, "pi");
		assert.deepEqual(args.slice(0, 4), ["--mode", "json", "--print", "--no-session"]);
		assert.equal(options.shell, false);
		actual = realSpawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		// Install close waiter immediately so kill/close cannot race past cleanup.
		closed = once(actual, "close");
		return actual;
	};
	const executor = createPiDelegateExecutor({ spawn });
	let handle: Awaited<ReturnType<typeof executor.launch>> | undefined;
	try {
		handle = await executor.launch(request);
		assert.equal(typeof handle.pid, "number");
		assert.notEqual(handle.pid, process.pid);
		process.kill(handle.pid, 0);
	} finally {
		if (actual && actual.exitCode === null && actual.signalCode === null) {
			actual.kill();
		}
		if (closed) {
			await withTimeout(closed, 5_000, "timed out waiting to reap real child process");
		}
	}
	assert.ok(actual);
	assert.ok(actual.exitCode !== null || actual.signalCode !== null);
	await handle?.settled;
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
			child.emit("close", 1);
			return error;
		},
		expectedEndCallsAfterFailure: 0,
		emitLateSpawn: true,
	});
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
	child.emit("close", 1);
	child.stdin.emit("error", new Error("later failure"));
	await assert.rejects(handle.settled, /first failure/);
});
