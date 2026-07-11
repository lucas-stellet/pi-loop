import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { requirementsFromObjective } from "./completion.ts";

export type LoopStateName = "idle" | "active" | "paused" | "complete" | "budget_limited" | "failed";

export type LoopState = {
	state: LoopStateName;
	objective: string;
	requirements: string[];
	maxIterations: number;
	iterationsUsed: number;
	maxTokens?: number;
	runId?: string;
	sequence?: number;
	startedAt?: number;
};

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export function initialLoopState(): LoopState {
	return {
		state: "idle",
		objective: "",
		requirements: [],
		maxIterations: 10,
		iterationsUsed: 0,
	};
}

export function activeLoopState(params: {
	objective: string;
	maxIterations?: number;
	maxTokens?: number;
}): LoopState {
	return {
		state: "active",
		objective: params.objective,
		requirements: requirementsFromObjective(params.objective),
		maxIterations: params.maxIterations ?? 10,
		iterationsUsed: 0,
		runId: randomUUID(),
		sequence: 0,
		startedAt: Date.now(),
		...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
	};
}

/** Opaque child identity safe for use as a filesystem path segment. */
export function createChildRunId(): string {
	return `child-${randomUUID()}`;
}

export function lastPersistedLoopState(ctx: ExtensionContext): LoopState | undefined {
	const sessionManager = ctx.sessionManager as unknown as { getEntries?: () => unknown[] };
	const entries = sessionManager.getEntries?.() ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntry;
		if (entry.type === "custom" && entry.customType === "loop-state") {
			return entry.data as LoopState;
		}
	}
	return undefined;
}
