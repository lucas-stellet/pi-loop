import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createChildArtifactStore, type ChildArtifactStore } from "./child-artifacts.ts";
import type { DelegateMetadata } from "./delegate-registry.ts";
import { PiJsonFinalCapture } from "./pi-json-final-capture.ts";

export type DelegateLaunchRequest = Readonly<{
	parentRunId: string;
	childRunId: string;
	cwd: string;
	task: string;
	metadata: DelegateMetadata;
}>;

export type DelegateLaunchHandle = Readonly<{
	pid: number;
	artifactRefs: Promise<readonly string[]>;
	settled: Promise<void>;
}>;

export class DelegateCancellationError extends Error {
	readonly signal: NodeJS.Signals;

	constructor(signal: NodeJS.Signals) {
		super(`Pi child cancelled by ${signal}.`);
		this.name = "DelegateCancellationError";
		this.signal = signal;
	}
}

export interface DelegateExecutor {
	launch(request: DelegateLaunchRequest): Promise<DelegateLaunchHandle>;
}

/** Factory-owned spawn seam. Production omits it and uses real Node `spawn`. */
export type PiDelegateSpawn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

export type ChildArtifactStoreFactory = (request: {
	cwd: string;
	parentRunId: string;
	childRunId: string;
}) => Promise<ChildArtifactStore>;

export type PiDelegateExecutorOptions = Readonly<{
	spawn?: PiDelegateSpawn;
	createArtifactStore?: ChildArtifactStoreFactory;
}>;

function fixedPiArgv(metadata: DelegateMetadata): string[] {
	return [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--tools",
		metadata.tools.join(","),
		"--append-system-prompt",
		metadata.systemPrompt,
	];
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Drain one child pipe into the artifact store with real Writable backpressure. */
function drainChildOutput(
	stream: NodeJS.ReadableStream | null,
	store: Promise<ChildArtifactStore>,
	write: (store: ChildArtifactStore, chunk: Buffer) => Promise<void>,
): Promise<void> {
	if (stream === null) {
		return Promise.reject(new Error("Pi child did not provide a piped output stream."));
	}
	return pipeline(
		stream,
		new Writable({
			write(chunk, _encoding, callback) {
				if (!Buffer.isBuffer(chunk)) {
					callback(new Error("Pi child output was not binary."));
					return;
				}
				void store
					.then((artifactStore) => write(artifactStore, chunk))
					.then(() => callback(), callback);
			},
		}),
	);
}

/** Starts a separate Pi CLI process; task text is deliberately sent through stdin, never argv. */
export function createPiDelegateExecutor(options: PiDelegateExecutorOptions = {}): DelegateExecutor {
	const spawnProcess = options.spawn ?? spawn;
	const createArtifactStore = options.createArtifactStore ?? createChildArtifactStore;

	return {
		async launch(request) {
			const store = createArtifactStore({
				cwd: request.cwd,
				parentRunId: request.parentRunId,
				childRunId: request.childRunId,
			});
			const child = spawnProcess("pi", fixedPiArgv(request.metadata), {
				cwd: request.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stdout = child.stdout;
			const stderr = child.stderr;

			let cleanupDone = false;
			const cleanup = (error: Error) => {
				if (cleanupDone) return;
				cleanupDone = true;
				stdout?.destroy(error);
				stderr?.destroy(error);
				child.stdin?.destroy?.(error);
				child.kill();
			};

			const finalCapture = new PiJsonFinalCapture();
			// Start both drains promptly so output-before-stdin cannot fill a pipe and deadlock.
			const artifactRefs = Promise.all([
				drainChildOutput(stdout, store, (artifactStore, chunk) => {
					finalCapture.write(chunk);
					return artifactStore.writeStdout(chunk);
				}),
				drainChildOutput(stderr, store, (artifactStore, chunk) => artifactStore.writeStderr(chunk)),
			]).then(async () => {
				const final = finalCapture.finish();
				return (await store).finalize(final === undefined ? {} : { final });
			});
			let failLaunch: ((error: Error) => void) | undefined;
			let firstFailure: Error | undefined;
			// Store/drain failures must tear down sibling resources; observe so discarded handles stay quiet.
			void store.catch((error) => {
				const failure = asError(error);
				cleanup(failure);
				failLaunch?.(failure);
			});
			void artifactRefs.catch((error) => {
				const failure = asError(error);
				cleanup(failure);
				failLaunch?.(failure);
			});

			let resolveProcessOutcome!: (error?: Error) => void;
			const processOutcome = new Promise<Error | undefined>((resolve) => {
				resolveProcessOutcome = resolve;
			});
			let processDone = false;
			const finishProcess = (error?: Error) => {
				if (processDone) return;
				processDone = true;
				resolveProcessOutcome(error);
			};
			// Wait for process close and drain/finalize; prefer artifact failure over process outcome.
			const settled = Promise.allSettled([processOutcome, artifactRefs]).then(([outcome, artifacts]) => {
				if (artifacts.status === "rejected") throw artifacts.reason;
				if (outcome.status === "rejected") throw outcome.reason;
				if (outcome.value) throw outcome.value;
			});
			// Observe rejection so a discarded handle cannot surface as unhandledRejection.
			void settled.catch(() => {});

			return new Promise<DelegateLaunchHandle>((resolve, reject) => {
				let launchDone = false;
				let deliveryStarted = false;
				const fail = (error: Error) => {
					const failure = (firstFailure ??= error);
					if (!launchDone) {
						launchDone = true;
						reject(failure);
					}
					cleanup(failure);
				};
				failLaunch = fail;
				const stdin = child.stdin;

				child.on("error", fail);
				child.on("close", (_code, signal) => {
					if (!launchDone) fail(new Error("Pi child closed before launch confirmation."));
					finishProcess(firstFailure ?? (signal === null ? undefined : new DelegateCancellationError(signal)));
				});

				if (stdin === null) {
					fail(new Error("Pi child did not provide stdin."));
					return;
				}
				stdin.on("error", fail);
				child.on("spawn", () => {
					if (launchDone || processDone || deliveryStarted) return;
					const pid = child.pid;
					if (typeof pid !== "number") {
						fail(new Error("Pi child did not provide a process id."));
						return;
					}
					deliveryStarted = true;
					try {
						stdin.end(request.task, () => {
							if (launchDone || processDone) return;
							launchDone = true;
							resolve({ pid, artifactRefs, settled });
						});
					} catch (error) {
						fail(asError(error));
					}
				});
			});
		},
	};
}
