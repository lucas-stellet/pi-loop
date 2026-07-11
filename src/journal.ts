import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loopRunDirectory } from "./loop-paths.ts";
import type { LoopState } from "./loop-state.ts";

/** Pi session custom entry that mirrors a committed JSONL event (observability only). */
const EVENT_ENTRY_TYPE = "loop-event";
/** Pi session custom entry that stores companion loop-state snapshots (not event authority). */
const SNAPSHOT_ENTRY_TYPE = "loop-state";
const SCHEMA_VERSION = 1;
const EVENTS_FILE = "events.jsonl";
const UNHEALTHY_JOURNAL_ERROR = "Loop journal is unhealthy.";
/** Loop lifecycle kinds that must FileHandle.sync() before session mirror / exposure. */
const SETTLEMENT_KINDS = new Set([
	"loop.paused",
	"loop.cleared",
	"loop.completed",
	"loop.failed",
	"loop.budget_limited",
]);
/** Terminal `delegation.updated` statuses that also require settlement-grade sync. */
const TERMINAL_DELEGATION_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type JournalEvent = {
	schemaVersion: typeof SCHEMA_VERSION;
	runId: string | undefined;
	sequence: number;
	timestamp: number;
	kind: string;
	payload: Record<string, unknown>;
};

/** Canonical on-disk envelope; runId is always a concrete string. */
type DiskJournalEvent = Omit<JournalEvent, "runId"> & { runId: string };

export type Journal = {
	startRun(runId: string, initialSequence?: number): void;
	appendEvent(kind: string, payload?: Record<string, unknown>): void;
	updateSnapshot(state: LoopState): void;
	getSnapshot(): LoopState | undefined;
	isHealthy(): boolean;
	getRunId(): string | undefined;
	getSequence(): number;
	getEvents(): readonly JournalEvent[];
};

export type DiskJournal = Omit<Journal, "startRun" | "appendEvent"> & {
	/** Open/create the run journal; sequence is recovered from validated JSONL only. */
	startRun(runId: string): Promise<void>;
	appendEvent(kind: string, payload?: Record<string, unknown>): Promise<void>;
};

type DiskOptions = { cwd: string | (() => string) };
type AppendEntry = (customType: string, data: unknown) => void;

async function ensureJournalDirectory(cwd: string, runId: string): Promise<string> {
	const directory = loopRunDirectory(cwd, runId);
	await mkdir(directory, { recursive: true });
	for (const path of [resolve(cwd, ".pi"), resolve(cwd, ".pi", "loop"), directory]) {
		const stat = await lstat(path);
		if (!stat.isDirectory()) {
			throw new Error("Loop journal directory is unsafe.");
		}
	}
	return directory;
}

function assertSafeJournalFile(stat: { isFile(): boolean; nlink: number }): void {
	if (!stat.isFile() || stat.nlink !== 1) {
		throw new Error("Loop journal destination is unsafe.");
	}
}

async function openJournal(path: string, flags: number): Promise<FileHandle> {
	const handle = await open(path, flags | fsConstants.O_NOFOLLOW, 0o600);
	try {
		assertSafeJournalFile(await handle.stat());
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEvent(value: unknown, runId: string, expectedSequence: number): asserts value is DiskJournalEvent {
	if (!isRecord(value)) {
		throw new Error("Loop journal contains an invalid event record.");
	}

	const valid =
		value.schemaVersion === SCHEMA_VERSION &&
		value.runId === runId &&
		value.sequence === expectedSequence &&
		Number.isFinite(value.timestamp) &&
		typeof value.kind === "string" &&
		isRecord(value.payload);

	if (!valid) {
		throw new Error("Loop journal contains an invalid event record.");
	}
}

function eventSnapshot(events: readonly JournalEvent[]): readonly JournalEvent[] {
	return structuredClone(events);
}

function createEvent(
	runId: string,
	sequence: number,
	kind: string,
	payload: Record<string, unknown>,
): DiskJournalEvent;
function createEvent(
	runId: string | undefined,
	sequence: number,
	kind: string,
	payload: Record<string, unknown>,
): JournalEvent;
function createEvent(
	runId: string | undefined,
	sequence: number,
	kind: string,
	payload: Record<string, unknown>,
): JournalEvent {
	return {
		schemaVersion: SCHEMA_VERSION,
		runId,
		sequence,
		timestamp: Date.now(),
		kind,
		// Clone so later mutation of the caller's payload object cannot rewrite authority.
		payload: structuredClone(payload),
	};
}

function createSessionJournal(appendEntry: AppendEntry): Journal {
	let runId: string | undefined;
	let sequence = 0;
	let healthy = true;
	let snapshot: LoopState | undefined;
	let events: JournalEvent[] = [];

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
			events = [];
			healthy = true;
		},
		appendEvent(kind: string, payload: Record<string, unknown> = {}) {
			const nextSequence = sequence + 1;
			const event = createEvent(runId, nextSequence, kind, payload);
			persist(EVENT_ENTRY_TYPE, event);
			sequence = nextSequence;
			events.push(event);
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
		getEvents() {
			return eventSnapshot(events);
		},
	};
}

function createDiskJournal(appendEntry: AppendEntry, options: DiskOptions): DiskJournal {
	let runId: string | undefined;
	let sequence = 0;
	let healthy = true;
	let snapshot: LoopState | undefined;
	let events: DiskJournalEvent[] = [];
	// Single serialized writer: sequence assignment + durable append + optional settlement + mirror.
	let queue = Promise.resolve();

	function resolveCwd(): string {
		return typeof options.cwd === "function" ? options.cwd() : options.cwd;
	}

	async function eventsPath(nextRunId: string): Promise<string> {
		return join(await ensureJournalDirectory(resolveCwd(), nextRunId), EVENTS_FILE);
	}

	function fail(error: unknown): never {
		healthy = false;
		throw error;
	}

	function persistMirror(customType: string, data: unknown) {
		try {
			appendEntry(customType, data);
		} catch (error) {
			fail(error);
		}
	}

	async function replay(nextRunId: string): Promise<void> {
		let handle: FileHandle | undefined;
		try {
			handle = await openJournal(await eventsPath(nextRunId), fsConstants.O_RDWR | fsConstants.O_CREAT);
			let content = await handle.readFile("utf8");

			// Repair only a torn trailing fragment (bytes after the last complete newline).
			if (!content.endsWith("\n")) {
				const lastNewline = content.lastIndexOf("\n");
				content = lastNewline < 0 ? "" : content.slice(0, lastNewline + 1);
				await handle.truncate(Buffer.byteLength(content));
			}

			let replayedSequence = 0;
			const replayedEvents: DiskJournalEvent[] = [];
			for (const line of content.split("\n")) {
				if (!line) {
					continue;
				}
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					throw new Error("Loop journal contains an invalid event record.");
				}
				validateEvent(event, nextRunId, replayedSequence + 1);
				replayedEvents.push(event);
				replayedSequence += 1;
			}

			runId = nextRunId;
			sequence = replayedSequence;
			events = replayedEvents;
		} finally {
			await handle?.close();
		}
	}

	function requiresSettlementSync(kind: string, payload: Record<string, unknown>): boolean {
		return (
			SETTLEMENT_KINDS.has(kind) ||
			(kind === "delegation.updated" &&
				typeof payload.status === "string" &&
				TERMINAL_DELEGATION_STATUSES.has(payload.status))
		);
	}

	async function appendDiskEvent(kind: string, payload: Record<string, unknown> = {}): Promise<void> {
		if (!runId) {
			throw new Error("Loop journal has no active run.");
		}

		const event = createEvent(runId, sequence + 1, kind, payload);
		let handle: FileHandle | undefined;
		try {
			handle = await openJournal(
				await eventsPath(runId),
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
			);
			// Canonical fact first: file-level sync is the MVP durability boundary; directory fsync is out of scope.
			await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
			if (requiresSettlementSync(kind, payload)) {
				await handle.sync();
			}
			// Advance only after the durable write path succeeds; poison still leaves replay as authority.
			sequence = event.sequence;
			events.push(event);
			persistMirror(EVENT_ENTRY_TYPE, event);
		} finally {
			await handle?.close();
		}
	}

	function enqueue(action: () => Promise<void>): Promise<void> {
		if (!healthy) {
			return Promise.reject(new Error(UNHEALTHY_JOURNAL_ERROR));
		}
		const pending = queue.then(async () => {
			// Re-check at execution time so already-queued followers observe poison from earlier work.
			if (!healthy) {
				throw new Error(UNHEALTHY_JOURNAL_ERROR);
			}
			try {
				await action();
			} catch (error) {
				// Poison before the next queued callback can start (do not wait for caller-facing catch).
				fail(error);
			}
		});
		// Keep the chain alive after a rejected task so later enqueues still serialize.
		queue = pending.catch(() => undefined);
		return pending;
	}

	return {
		startRun(nextRunId: string) {
			// Reset health so recovery can open a run after a prior failure; sequence comes from JSONL.
			healthy = true;
			return enqueue(() => replay(nextRunId));
		},
		appendEvent(kind: string, payload: Record<string, unknown> = {}) {
			return enqueue(() => appendDiskEvent(kind, payload));
		},
		updateSnapshot(state: LoopState) {
			// Companion snapshot only; JSONL remains the authoritative event timeline.
			if (!healthy) {
				throw new Error(UNHEALTHY_JOURNAL_ERROR);
			}
			persistMirror(SNAPSHOT_ENTRY_TYPE, state);
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
		getEvents() {
			return eventSnapshot(events);
		},
	};
}

/**
 * Session-only journal (legacy/tests) or disk-backed canonical JSONL journal.
 * When `options` is provided, `.pi/loop/<runId>/events.jsonl` is the authority and
 * `appendEntry` is only the Pi session mirror.
 */
export function createJournal(appendEntry: AppendEntry): Journal;
export function createJournal(appendEntry: AppendEntry, options: DiskOptions): DiskJournal;
export function createJournal(appendEntry: AppendEntry, options?: DiskOptions): Journal | DiskJournal {
	if (!options) {
		return createSessionJournal(appendEntry);
	}
	return createDiskJournal(appendEntry, options);
}
