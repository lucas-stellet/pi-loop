import assert from "node:assert/strict";
import test from "node:test";

import {
	projectEvents,
	projectRunContext,
	renderDecisionContext,
	type ProjectableEvent,
	type EventProjection,
} from "../src/projection.ts";

function event(
	sequence: number,
	kind: string,
	payload: Record<string, unknown> = {},
	runId = "run-1",
): ProjectableEvent {
	return { schemaVersion: 1, runId, sequence, timestamp: sequence * 1000, kind, payload };
}

function codes(projection: EventProjection): Array<[string, number]> {
	return projection.invalidFacts.map((fact) => [fact.code, fact.sequence]);
}

test("projects a deterministic, requirement-grouped read model without deciding semantic completion", () => {
	const events = [
		event(1, "loop.started", { maxIterations: 4, tokenBudget: 1000 }),
		event(2, "loop.iteration", { used: 1, requirementIds: ["REQ-1"] }),
		event(3, "delegation.updated", {
			childId: "child-1",
			status: "completed",
			artifactRefs: ["artifacts/child-1.json"],
			requirementIds: ["REQ-1"],
		}),
		event(4, "validation.completed", {
			command: "npm test",
			outcome: "passed",
			requirementIds: ["REQ-1"],
			references: [{ runId: "run-1", sequence: 3 }],
		}),
		event(5, "review.completed", {
			verdict: "approved",
			findings: ["none"],
			requirementIds: ["REQ-2"],
		}),
		event(6, "workspace.changed", { files: ["src/projection.ts"], requirementIds: ["REQ-1"] }),
		event(7, "blocker.raised", { message: "waiting on API", requirementIds: ["REQ-2"] }),
		event(8, "failure.recorded", { message: "adapter timeout" }),
		event(9, "retry.recorded", { attempt: 2, reason: "transient" }),
		event(10, "nit.recorded", { message: "prefer early return" }),
		event(11, "budget.updated", { tokensUsed: 120 }),
		event(12, "supervisor.assessment", {
			requirementId: "REQ-1",
			verdict: "satisfied",
			references: [{ runId: "run-1", sequence: 4 }],
		}),
		event(13, "loop.paused", { reason: "manual" }),
	];

	const first = projectEvents({ runId: "run-1", events });
	const second = projectEvents({ runId: "run-1", events: structuredClone(events) });

	assert.deepEqual(first, second);
	assert.deepEqual(first.lifecycle, { state: "paused", settlement: undefined, highWater: 13 });
	assert.deepEqual(first.iteration, { used: 1, max: 4 });
	assert.deepEqual(first.budget, { tokensUsed: 120, tokensMax: 1000 });
	assert.deepEqual(first.delegations, [
		{ sequence: 3, childId: "child-1", status: "completed", artifactRefs: ["artifacts/child-1.json"] },
	]);
	assert.deepEqual(first.validations, [{ sequence: 4, command: "npm test", outcome: "passed" }]);
	assert.deepEqual(first.reviews, [{ sequence: 5, verdict: "approved", findings: ["none"] }]);
	assert.deepEqual(first.workspaceChanges, [{ sequence: 6, files: ["src/projection.ts"] }]);
	assert.deepEqual(first.blockers, [{ sequence: 7, message: "waiting on API" }]);
	assert.deepEqual(first.failures, [{ sequence: 8, message: "adapter timeout" }]);
	assert.deepEqual(first.retries, [{ sequence: 9, attempt: 2, reason: "transient" }]);
	assert.deepEqual(first.nits, [{ sequence: 10, message: "prefer early return" }]);
	assert.deepEqual(first.requirements["REQ-1"]!.eventSequences, [2, 3, 4, 6, 12]);
	assert.deepEqual(first.requirements["REQ-2"]!.eventSequences, [5, 7]);
	assert.deepEqual(first.assessments, [
		{ sequence: 12, requirementId: "REQ-1", verdict: "satisfied", references: [4] },
	]);
	assert.equal("objectiveComplete" in first, false);
	assert.equal(first.invalidFacts.length, 0);
});

test("lifecycle FSM allows pause/resume and only true terminals settle", () => {
	const events = [
		event(1, "loop.started", { maxIterations: 2 }),
		event(2, "loop.paused"),
		event(3, "loop.resumed"),
		event(4, "loop.iteration", { used: 1 }),
		event(5, "loop.completed"),
	];
	const projection = projectEvents({ runId: "run-1", events });
	assert.deepEqual(projection.lifecycle, { state: "completed", settlement: "completed", highWater: 5 });
	assert.equal(projection.iteration.used, 1);
	assert.deepEqual(codes(projection), []);
});

const lifecycleCases: Array<{
	name: string;
	events: ProjectableEvent[];
	state: string;
	settlement: string | undefined;
	diagnostics: Array<[string, number]>;
}> = [
	{
		name: "resume before pause",
		events: [event(1, "loop.started"), event(2, "loop.resumed")],
		state: "active",
		settlement: undefined,
		diagnostics: [["resume-before-pause", 2]],
	},
	{
		name: "pause when not active",
		events: [event(1, "loop.paused")],
		state: "idle",
		settlement: undefined,
		diagnostics: [["pause-when-not-active", 1]],
	},
	{
		name: "duplicate start",
		events: [event(1, "loop.started"), event(2, "loop.started")],
		state: "active",
		settlement: undefined,
		diagnostics: [["duplicate-start", 2]],
	},
	{
		name: "lifecycle after terminal settlement",
		events: [event(1, "loop.started"), event(2, "loop.completed"), event(3, "loop.resumed")],
		state: "completed",
		settlement: "completed",
		diagnostics: [["lifecycle-after-settlement", 3]],
	},
	{
		name: "conflicting terminal after settlement",
		events: [event(1, "loop.started"), event(2, "loop.completed"), event(3, "loop.failed")],
		state: "completed",
		settlement: "completed",
		diagnostics: [["conflicting-settlement", 3]],
	},
];

for (const scenario of lifecycleCases) {
	test(`lifecycle diagnostic: ${scenario.name}`, () => {
		const projection = projectEvents({ runId: "run-1", events: scenario.events });
		assert.equal(projection.lifecycle.state, scenario.state);
		assert.equal(projection.lifecycle.settlement, scenario.settlement);
		assert.deepEqual(codes(projection), scenario.diagnostics);
	});
}

test("foreign-run envelopes never satisfy references or affect high-water", () => {
	const events = [
		event(1, "loop.started"),
		event(50, "delegation.updated", { childId: "foreign", status: "completed", artifactRefs: [] }, "other-run"),
		event(2, "validation.completed", {
			command: "npm test",
			outcome: "passed",
			references: [{ runId: "run-1", sequence: 50 }],
		}),
		event(3, "review.completed", {
			verdict: "approved",
			findings: [],
			references: [{ runId: "other-run", sequence: 50 }],
		}),
	];
	const projection = projectEvents({ runId: "run-1", events });
	assert.equal(projection.lifecycle.highWater, 3);
	assert.equal(projection.delegations.length, 0);
	assert.deepEqual(codes(projection), [
		["missing-reference", 2],
		["cross-run-reference", 3],
	]);
	assert.deepEqual(
		projection.unresolvedFacts.map((fact) => [fact.code, fact.sequence]),
		[
			["missing-reference", 2],
			["cross-run-reference", 3],
		],
	);
});

test("reports malformed payloads, malformed references, and invalid causal order", () => {
	const events = [
		event(1, "loop.started"),
		event(2, "delegation.updated", { childId: "child-1", status: "running", artifactRefs: ["a.json"], childLog: "SECRET" }),
		event(3, "blocker.raised", { references: [{ runId: "other-run", sequence: 1 }] }),
		event(4, "validation.completed", { command: "npm test", outcome: "passed", references: [{ runId: "run-1", sequence: 99 }] }),
		event(5, "review.completed", { verdict: "approved", findings: [], references: [{ runId: "run-1", sequence: 6 }] }),
		event(6, "delegation.updated", { childId: "missing-status" }),
		event(7, "validation.completed", { command: "npm test", outcome: "passed", references: "not-an-array" }),
		event(8, "loop.completed"),
		event(9, "loop.resumed"),
	];
	const projection = projectEvents({ runId: "run-1", events });
	assert.deepEqual(codes(projection), [
		["cross-run-reference", 3],
		["malformed-payload", 3], // blocker without message
		["missing-reference", 4],
		["invalid-causal-order", 5],
		["malformed-payload", 6],
		["malformed-reference", 7],
		["lifecycle-after-settlement", 9],
	]);
});

test("requirement ids are prototype-safe including __proto__", () => {
	const events = [
		event(1, "loop.started"),
		event(2, "nit.recorded", { message: "proto", requirementId: "__proto__" }),
		event(3, "nit.recorded", { message: "ctor", requirementIds: ["constructor"] }),
	];
	const projection = projectEvents({ runId: "run-1", events });
	assert.deepEqual(projection.requirements["__proto__"]!.eventSequences, [2]);
	assert.deepEqual(projection.requirements["constructor"]!.eventSequences, [3]);
	assert.equal(Object.getPrototypeOf(projection.requirements), null);
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("renderer is bounded, deterministic, whole-line only, and never leaks raw logs or JSONL", () => {
	const events = [
		event(1, "loop.started", { maxIterations: 3, tokenBudget: 500 }),
		event(2, "delegation.updated", {
			childId: "child-1",
			status: "completed",
			artifactRefs: ["artifacts/child-1.json"],
			childLog: "SECRET CHILD LOG",
			payloadDump: '{"schemaVersion":1}',
		}),
		event(3, "blocker.raised", { message: "waiting" }),
		event(4, "validation.completed", { command: "npm test", outcome: "passed" }),
		event(5, "review.completed", { verdict: "approved", findings: ["nit"] }),
		event(6, "workspace.changed", { files: ["src/a.ts"] }),
		event(7, "failure.recorded", { message: "boom" }),
		event(8, "retry.recorded", { attempt: 1 }),
		event(9, "nit.recorded", { message: "style" }),
		event(10, "supervisor.assessment", { requirementId: "REQ-1", verdict: "satisfied", references: [] }),
	];
	const projection = projectEvents({ runId: "run-1", events });
	const large = renderDecisionContext(projection, { maxCharacters: 10_000 });
	const again = renderDecisionContext(projection, { maxCharacters: 10_000 });
	assert.equal(large, again);
	assert.match(large, /#2/);
	assert.match(large, /artifacts\/child-1\.json/);
	assert.doesNotMatch(large, /SECRET CHILD LOG|schemaVersion|"payload"|payloadDump/);

	assert.equal(renderDecisionContext(projection, { maxCharacters: 0 }), "");
	const tiny = renderDecisionContext(projection, { maxCharacters: 40 });
	assert.ok(tiny.length <= 40);
	assert.doesNotMatch(tiny, /SECRET/);
	// Whole-line policy: either empty, an omission marker, or complete lines — never a mid-token cut of artifact paths.
	if (tiny.includes("artifacts/")) {
		assert.match(tiny, /artifacts\/child-1\.json/);
	}

	const medium = renderDecisionContext(projection, { maxCharacters: 180 });
	assert.ok(medium.length <= 180);
	if (medium.includes("…(")) {
		assert.match(medium, /…\(\d+ more\)/);
	}
});

test("projectRunContext pairs projection with bounded context for the active run", () => {
	const { projection, context } = projectRunContext({
		runId: "run-1",
		events: [event(1, "loop.started", { maxIterations: 1 }), event(2, "loop.iteration", { used: 1 })],
		maxCharacters: 500,
	});
	assert.equal(projection.lifecycle.state, "active");
	assert.ok(context.length <= 500);
	assert.match(context, /Lifecycle: active/);
});
