import assert from "node:assert/strict";
import { test } from "node:test";

import { semanticCompletionSequences } from "../src/completion.ts";

const runId = "active-run";

function event(
	sequence: number,
	kind: string,
	payload: Record<string, unknown> = {},
	eventRunId = runId,
) {
	return { sequence, kind, payload, runId: eventRunId };
}

function missingRunEvent(sequence: number, kind: string, payload: Record<string, unknown> = {}) {
	return { sequence, kind, payload };
}

test("semantic completion evidence has a closed current-run allowlist", () => {
	const events = [
		event(101, "workspace.changed", { arbitrary: null }),
		event(102, "validation.completed", { arbitrary: null }),
		event(103, "review.completed", { arbitrary: null }),
		event(104, "nit.recorded", { arbitrary: null }),
		event(105, "blocker.raised", { arbitrary: null }),
		event(106, "failure.recorded", { arbitrary: null }),
		event(107, "retry.recorded", { arbitrary: null }),
		event(108, "delegation.updated", { status: "completed" }),
		event(201, "loop.started"),
		event(202, "loop.iteration"),
		event(203, "loop.paused"),
		event(204, "loop.resumed"),
		event(205, "loop.guardrail_violation"),
		event(206, "budget.updated"),
		event(207, "supervisor.assessment"),
		event(208, "loop.completed"),
		event(209, "loop.failed"),
		event(210, "loop.cleared"),
		event(211, "loop.budget_limited"),
		event(212, "future.unknown"),
		...(["started", "running", "failed", "cancelled", "Completed", "other"] as const).map((status, index) =>
			event(220 + index, "delegation.updated", { status }),
		),
		event(226, "delegation.updated"),
		event(227, "delegation.updated", { status: 1 }),
		event(301, "validation.completed", {}, "foreign-run"),
		missingRunEvent(302, "validation.completed"),
		event(101, "validation.completed"),
	];

	assert.deepEqual(
		semanticCompletionSequences(events, runId),
		new Set([101, 102, 103, 104, 105, 106, 107, 108]),
	);
});

test("semantic completion evidence fails closed without an active run identity", () => {
	assert.deepEqual(
		semanticCompletionSequences([
			missingRunEvent(7, "validation.completed"),
			missingRunEvent(8, "loop.started"),
		], undefined),
		new Set(),
	);
});
