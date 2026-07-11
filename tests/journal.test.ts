import assert from "node:assert/strict";
import test from "node:test";

import { createJournal } from "../src/journal.ts";
import type { LoopState } from "../src/loop-state.ts";

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
