import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJournal, type DiskJournal } from "../src/journal.ts";
import type { LoopState } from "../src/loop-state.ts";
import { withFileHandleMethod } from "./helpers.ts";

type AppendedEntry = {
	customType: string;
	data: unknown;
};

function createState(overrides: Partial<LoopState> = {}): LoopState {
	return {
		state: "active",
		objective: "ship the journal",
		requirements: ["journal persists state"],
		maxIterations: 3,
		iterationsUsed: 1,
		runId: "run-1",
		sequence: 0,
		startedAt: 123,
		...overrides,
	};
}

function createHarness(options: { failOnWrite?: boolean } = {}) {
	const entries: AppendedEntry[] = [];
	const appendEntry = (customType: string, data: unknown) => {
		if (options.failOnWrite) {
			throw new Error("journal write failed");
		}
		entries.push({ customType, data });
	};
	return { entries, appendEntry };
}

function createDiskJournal(
	appendEntry: (customType: string, data: unknown) => void,
	options: { cwd: string },
): DiskJournal {
	return createJournal(appendEntry, options);
}

async function withTemporaryCwd(run: (cwd: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-journal-test-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function eventPath(cwd: string, runId = "run-1") {
	return join(cwd, ".pi", "loop", runId, "events.jsonl");
}

async function readEvents(cwd: string, runId = "run-1") {
	const content = await readFile(eventPath(cwd, runId), "utf8");
	return content
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("journal appends ordered event envelopes for a durable run identity", () => {
	const harness = createHarness();
	const journal = createJournal(harness.appendEntry);

	journal.startRun("run-1");
	journal.appendEvent("loop.started", { objective: "ship the journal" });
	journal.appendEvent("loop.paused", { reason: "manual" });
	journal.appendEvent("loop.resumed", {});

	assert.equal(journal.getRunId(), "run-1");
	assert.equal(journal.getSequence(), 3);
	assert.deepEqual(
		harness.entries.map((entry) => entry.customType),
		["loop-event", "loop-event", "loop-event"],
	);

	const events = harness.entries.map((entry) => entry.data as Record<string, unknown>);
	assert.deepEqual(
		events.map((event) => event.sequence),
		[1, 2, 3],
	);
	assert.deepEqual(
		events.map((event) => event.runId),
		["run-1", "run-1", "run-1"],
	);
	assert.deepEqual(
		events.map((event) => event.kind),
		["loop.started", "loop.paused", "loop.resumed"],
	);
	assert.equal(events[0].schemaVersion, 1);
	assert.equal(typeof events[0].timestamp, "number");
	assert.deepEqual(events[0].payload, { objective: "ship the journal" });
});

test("disk journal durably appends its envelope before mirroring it to Pi", async () => {
	await withTemporaryCwd(async (cwd) => {
		const entries: AppendedEntry[] = [];
		const journal = createDiskJournal((customType, data) => {
			assert.equal(customType, "loop-event");
			assert.equal(existsSync(eventPath(cwd)), true, "canonical event must exist before its mirror");
			const persisted = readFileSync(eventPath(cwd), "utf8");
			assert.match(persisted, /\"sequence\":1/);
			entries.push({ customType, data });
		}, { cwd });

		await journal.startRun("run-1");
		await journal.appendEvent("loop.started", { objective: "ship the journal" });

		assert.deepEqual(await readEvents(cwd), [
			{
				schemaVersion: 1,
				runId: "run-1",
				sequence: 1,
				timestamp: (entries[0]!.data as Record<string, unknown>).timestamp,
				kind: "loop.started",
				payload: { objective: "ship the journal" },
			},
		]);
	});
});

test("disk journal serializes concurrent submissions in physical and mirror order", async () => {
	await withTemporaryCwd(async (cwd) => {
		const harness = createHarness();
		const journal = createDiskJournal(harness.appendEntry, { cwd });
		await journal.startRun("run-1");

		await Promise.all([
			journal.appendEvent("loop.started"),
			journal.appendEvent("loop.paused"),
			journal.appendEvent("loop.resumed"),
		]);

		assert.deepEqual((await readEvents(cwd)).map((event) => event.sequence), [1, 2, 3]);
		assert.deepEqual(
			harness.entries.map((entry) => (entry.data as Record<string, unknown>).sequence),
			[1, 2, 3],
		);
	});
});

test("disk journal replays a valid log and safely removes only a partial trailing record", async () => {
	await withTemporaryCwd(async (cwd) => {
		await mkdir(join(cwd, ".pi", "loop", "run-1"), { recursive: true });
		await writeFile(
			eventPath(cwd),
			'{"schemaVersion":1,"runId":"run-1","sequence":1,"timestamp":1,"kind":"loop.started","payload":{}}\n{"schemaVersion":1',
			"utf8",
		);
		const journal = createDiskJournal(createHarness().appendEntry, { cwd });

		await journal.startRun("run-1");
		await journal.appendEvent("loop.paused");

		assert.deepEqual((await readEvents(cwd)).map((event) => event.sequence), [1, 2]);
		assert.equal(journal.getSequence(), 2);
	});
});

test("journal exposes a defensive validated event snapshot with append and replay parity", async () => {
	await withTemporaryCwd(async (cwd) => {
		const journal = createDiskJournal(createHarness().appendEntry, { cwd });
		await journal.startRun("run-1");
		await journal.appendEvent("loop.started", { maxIterations: 2 });
		await journal.appendEvent("loop.iteration", { used: 1 });

		const appended = journal.getEvents();
		assert.deepEqual(
			appended.map(({ sequence, kind, payload }) => ({ sequence, kind, payload })),
			[
				{ sequence: 1, kind: "loop.started", payload: { maxIterations: 2 } },
				{ sequence: 2, kind: "loop.iteration", payload: { used: 1 } },
			],
		);
		appended[0]!.payload.maxIterations = 99;
		assert.equal(journal.getEvents()[0]!.payload.maxIterations, 2, "callers cannot mutate journal authority");

		const recovered = createDiskJournal(createHarness().appendEntry, { cwd });
		await recovered.startRun("run-1");
		assert.deepEqual(recovered.getEvents(), journal.getEvents(), "replay exposes the same validated stream as append");
	});
});

test("disk journal rejects a malformed complete record instead of treating it as replayed state", async () => {
	await withTemporaryCwd(async (cwd) => {
		await mkdir(join(cwd, ".pi", "loop", "run-1"), { recursive: true });
		await writeFile(
			eventPath(cwd),
			'{"schemaVersion":1,"runId":"run-1","sequence":2,"timestamp":1,"kind":"loop.started","payload":{}}\n',
			"utf8",
		);
		const harness = createHarness();
		const journal = createDiskJournal(harness.appendEntry, { cwd });

		await assert.rejects(() => journal.startRun("run-1"));
		assert.equal(journal.isHealthy(), false);
		assert.deepEqual(harness.entries, []);
	});
});

test("settlement events synchronize their record before it is mirrored", async () => {
	const settlementKinds = [
		"loop.paused",
		"loop.cleared",
		"loop.completed",
		"loop.failed",
		"loop.budget_limited",
	] as const;

	await withTemporaryCwd(async (cwd) => {
		const order: string[] = [];
		await withFileHandleMethod(
			"sync",
			(original) =>
				async function sync(this: FileHandle) {
					order.push("sync");
					return (original as () => Promise<void>).call(this);
				},
			async () => {
				for (const kind of settlementKinds) {
					order.length = 0;
					const journal = createDiskJournal(() => order.push("mirror"), { cwd });
					await journal.startRun(kind);
					await journal.appendEvent(kind);
					assert.ok(order.indexOf("sync") >= 0, `${kind} must synchronize its canonical record`);
					assert.ok(order.indexOf("sync") < order.indexOf("mirror"), `${kind} must sync before mirroring`);
				}
			},
		);
	});
});

test("a failed queued append poisons already-submitted followers before they write or mirror", async () => {
	await withTemporaryCwd(async (cwd) => {
		let eventWrites = 0;
		await withFileHandleMethod(
			"writeFile",
			(original) =>
				async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
					const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					if (text.includes('"kind":"loop.started"')) {
						eventWrites += 1;
						throw new Error("disk append failed");
					}
					if (text.includes('"kind":"loop.paused"')) {
						eventWrites += 1;
					}
					return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(
						this,
						data,
						options,
					);
				},
			async () => {
				const harness = createHarness();
				const journal = createDiskJournal(harness.appendEntry, { cwd });
				await journal.startRun("run-1");
				const first = journal.appendEvent("loop.started");
				const follower = journal.appendEvent("loop.paused");
				await assert.rejects(() => first, /disk append failed/);
				await assert.rejects(() => follower, /unhealthy|disk append failed/);
				assert.equal(eventWrites, 1, "a poisoned follower must not write another event");
				assert.deepEqual(harness.entries, [], "a canonical append failure must not publish mirrors");
				assert.equal(journal.isHealthy(), false);
			},
		);
	});
});

test("mirror failure preserves its disk event and rejects queued followers before another write", async () => {
	await withTemporaryCwd(async (cwd) => {
		let eventWrites = 0;
		let mirrors = 0;
		await withFileHandleMethod(
			"writeFile",
			(original) =>
				async function writeFile(this: FileHandle, data: string | Uint8Array, options?: unknown) {
					const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
					if (text.includes('"kind":"loop.started"') || text.includes('"kind":"loop.paused"')) {
						eventWrites += 1;
					}
					return (original as (data: string | Uint8Array, options?: unknown) => Promise<void>).call(this, data, options);
				},
			async () => {
				const journal = createDiskJournal(() => {
					mirrors += 1;
					throw new Error("Pi mirror failed");
				}, { cwd });
				await journal.startRun("run-1");
				const first = journal.appendEvent("loop.started");
				const follower = journal.appendEvent("loop.paused");
				await assert.rejects(() => first, /Pi mirror failed/);
				await assert.rejects(() => follower, /unhealthy|Pi mirror failed/);
				assert.equal(mirrors, 1);
				assert.deepEqual((await readEvents(cwd)).map((event) => event.sequence), [1]);
				assert.equal(eventWrites, 1, "a mirror-poisoned follower must not write another event");
			},
		);

		const recovered = createDiskJournal(createHarness().appendEntry, { cwd });
		await recovered.startRun("run-1");
		await recovered.appendEvent("loop.paused");
		assert.deepEqual((await readEvents(cwd)).map((event) => event.sequence), [1, 2]);
	});
});

test("sync failure poisons queued followers and replay advances past the written record", async () => {
	await withTemporaryCwd(async (cwd) => {
		let failSync = true;
		await withFileHandleMethod(
			"sync",
			(original) =>
				async function sync(this: FileHandle) {
					if (failSync) {
						throw new Error("sync failed");
					}
					return (original as () => Promise<void>).call(this);
				},
			async () => {
				const harness = createHarness();
				const journal = createDiskJournal(harness.appendEntry, { cwd });
				await journal.startRun("run-1");
				const failed = journal.appendEvent("loop.paused");
				const follower = journal.appendEvent("loop.resumed");
				await assert.rejects(() => failed, /sync failed/);
				await assert.rejects(() => follower, /unhealthy|sync failed/);
				assert.deepEqual((await readEvents(cwd)).map((event) => event.sequence), [1]);
				assert.deepEqual(harness.entries, [], "sync failure must not mirror the written record");

				failSync = false;
				const recovered = createDiskJournal(createHarness().appendEntry, { cwd });
				await recovered.startRun("run-1");
				await recovered.appendEvent("loop.resumed");
				assert.deepEqual((await readEvents(cwd)).map((event) => event.sequence), [1, 2]);
			},
		);
	});
});

test("disk journal failures fail closed without publishing a mirror", async () => {
	await withTemporaryCwd(async (cwd) => {
		await mkdir(eventPath(cwd), { recursive: true });
		const harness = createHarness();
		const journal = createDiskJournal(harness.appendEntry, { cwd });

		await assert.rejects(() => journal.startRun("run-1"));
		assert.equal(journal.isHealthy(), false);
		assert.deepEqual(harness.entries, []);
	});
});

test("journal maintains a current state snapshot without replaying events", () => {
	const harness = createHarness();
	const journal = createJournal(harness.appendEntry);
	const state = createState({ iterationsUsed: 2 });

	journal.updateSnapshot(state);

	assert.equal(journal.getSnapshot(), state);
	assert.deepEqual(harness.entries, [{ customType: "loop-state", data: state }]);
});

test("journal write failures fail closed and propagate to the caller", () => {
	const harness = createHarness({ failOnWrite: true });
	const journal = createJournal(harness.appendEntry);
	journal.startRun("run-1");

	assert.throws(
		() => journal.appendEvent("loop.started", { objective: "ship the journal" }),
		/journal write failed/,
	);
	assert.equal(journal.isHealthy(), false);
	assert.deepEqual(harness.entries, []);
});
