import type { LoopState } from "./loop-state.ts";

const EVENT_ENTRY_TYPE = "loop-event";
const SNAPSHOT_ENTRY_TYPE = "loop-state";
const SCHEMA_VERSION = 1;

type JournalEvent = {
	schemaVersion: typeof SCHEMA_VERSION;
	runId: string | undefined;
	sequence: number;
	timestamp: number;
	kind: string;
	payload: Record<string, unknown>;
};

export type Journal = {
	startRun(runId: string, initialSequence?: number): void;
	appendEvent(kind: string, payload?: Record<string, unknown>): void;
	updateSnapshot(state: LoopState): void;
	getSnapshot(): LoopState | undefined;
	isHealthy(): boolean;
	getRunId(): string | undefined;
	getSequence(): number;
};

export function createJournal(appendEntry: (customType: string, data: unknown) => void): Journal {
	let runId: string | undefined;
	let sequence = 0;
	let healthy = true;
	let snapshot: LoopState | undefined;

	function persist(customType: string, data: unknown) {
		try {
			appendEntry(customType, data);
		} catch (error) {
			healthy = false;
			throw error;
		}
	}

	return {
		startRun(nextRunId: string, initialSequence = 0) {
			runId = nextRunId;
			sequence = initialSequence;
			healthy = true;
		},
		appendEvent(kind: string, payload: Record<string, unknown> = {}) {
			const nextSequence = sequence + 1;
			const event: JournalEvent = {
				schemaVersion: SCHEMA_VERSION,
				runId,
				sequence: nextSequence,
				timestamp: Date.now(),
				kind,
				payload,
			};

			persist(EVENT_ENTRY_TYPE, event);
			sequence = nextSequence;
		},
		updateSnapshot(state: LoopState) {
			persist(SNAPSHOT_ENTRY_TYPE, state);
			snapshot = state;
		},
		getSnapshot() {
			return snapshot;
		},
		isHealthy() {
			return healthy;
		},
		getRunId() {
			return runId;
		},
		getSequence() {
			return sequence;
		},
	};
}
