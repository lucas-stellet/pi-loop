import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { DelegateMetadata } from "./delegate-registry.ts";

export type DelegateLaunchRequest = Readonly<{
	childRunId: string;
	cwd: string;
	task: string;
	metadata: DelegateMetadata;
}>;

export type DelegateLaunchHandle = Readonly<{
	pid: number;
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

export type PiDelegateExecutorOptions = Readonly<{
	spawn?: PiDelegateSpawn;
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

/** Starts a separate Pi CLI process; task text is deliberately sent through stdin, never argv. */
export function createPiDelegateExecutor(options: PiDelegateExecutorOptions = {}): DelegateExecutor {
	const spawnProcess = options.spawn ?? spawn;

	return {
		async launch(request) {
			const child = spawnProcess("pi", fixedPiArgv(request.metadata), {
				cwd: request.cwd,
				shell: false,
				stdio: ["pipe", "ignore", "ignore"],
			});

			let settle!: (error?: Error) => void;
			let settledDone = false;
			const settled = new Promise<void>((resolve, reject) => {
				settle = (error) => {
					if (settledDone) return;
					settledDone = true;
					if (error) reject(error);
					else resolve();
				};
			});
			// Observe rejection so a discarded handle cannot surface as unhandledRejection.
			// Return the original promise so later consumers still see the failure.
			void settled.catch(() => {});

			return new Promise<DelegateLaunchHandle>((resolve, reject) => {
				let launchDone = false;
				let deliveryStarted = false;

				const fail = (error: Error) => {
					if (!launchDone) {
						launchDone = true;
						reject(error);
					}
					settle(error);
				};

				const stdin = child.stdin;

				child.on("error", fail);
				child.on("close", (_code, signal) => {
					if (!launchDone) {
						fail(new Error("Pi child closed before launch confirmation."));
						return;
					}
					settle(signal === null ? undefined : new DelegateCancellationError(signal));
				});

				if (stdin === null) {
					fail(new Error("Pi child did not provide stdin."));
					return;
				}
				stdin.on("error", fail);

				child.on("spawn", () => {
					if (launchDone || settledDone || deliveryStarted) return;
					const pid = child.pid;
					if (typeof pid !== "number") {
						fail(new Error("Pi child did not provide a process id."));
						return;
					}
					deliveryStarted = true;
					try {
						const onDelivered = () => {
							if (launchDone || settledDone) return;
							launchDone = true;
							resolve({ pid, settled });
						};
						stdin.end(request.task, onDelivered);
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)));
					}
				});
			});
		},
	};
}
