import assert from "node:assert/strict";
import test from "node:test";

import { adaptChildStructuredResult } from "../src/child-result-adapter.ts";
import { validateChildStructuredResult } from "../src/child-structured-result.ts";

const childId = "child-123";
const runtimeRefs = [
	`children/${childId}/stdout.bin`,
	`children/${childId}/stderr.bin`,
	`children/${childId}/final.bin`,
	`children/${childId}/structured.bin`,
];

function result(value: object) {
	return validateChildStructuredResult(value)!;
}

test("adapts an eligible validated result into exact ordered child facts and present terminal fields", () => {
	const plan = adaptChildStructuredResult(result({
		summary: "kept exactly  ",
		confidence: 0,
		classification: "complete",
		artifactRefs: [runtimeRefs[0], runtimeRefs[3]],
		filesChanged: ["src/a.ts", "src/b.ts"],
		validations: [{ command: "npm test", outcome: "passed" }, { command: "npm run check", outcome: "passed" }],
		review: { verdict: "APPROVE", findings: ["none"] },
		nits: ["minor"],
		blockers: ["waiting"],
	}), childId, runtimeRefs);

	assert.deepEqual(plan, {
		facts: [
			{ kind: "workspace.changed", payload: { childId, files: ["src/a.ts", "src/b.ts"] } },
			{ kind: "validation.completed", payload: { childId, command: "npm test", outcome: "passed" } },
			{ kind: "validation.completed", payload: { childId, command: "npm run check", outcome: "passed" } },
			{ kind: "review.completed", payload: { childId, verdict: "APPROVE", findings: ["none"] } },
			{ kind: "nit.recorded", payload: { childId, message: "minor" } },
			{ kind: "blocker.raised", payload: { childId, message: "waiting" } },
		],
		terminalFields: {
			summary: "kept exactly  ",
			confidence: 0,
			classification: "complete",
			resultArtifactRefs: [runtimeRefs[0], runtimeRefs[3]],
		},
	});
});

test("keeps eligible empty authority distinct from rejected authority and preserves artifact-ref presence", () => {
	assert.deepEqual(adaptChildStructuredResult(result({}), childId, runtimeRefs), { facts: [], terminalFields: {} });
	assert.deepEqual(adaptChildStructuredResult(result({ artifactRefs: [] }), childId, runtimeRefs), {
		facts: [], terminalFields: { resultArtifactRefs: [] },
	});
	assert.equal(adaptChildStructuredResult(result({ summary: "ok" }), childId, runtimeRefs.slice(0, 3)), undefined);
	assert.equal(adaptChildStructuredResult(result({ artifactRefs: [runtimeRefs[0], runtimeRefs[0]] }), childId, runtimeRefs), undefined);
	assert.equal(adaptChildStructuredResult(result({ artifactRefs: ["children/other/structured.bin"] }), childId, runtimeRefs), undefined);
	assert.equal(adaptChildStructuredResult(result({ artifactRefs: ["unsafe"] }), childId, runtimeRefs), undefined);
});

test("defensively owns planned array payloads", () => {
	const source = {
		artifactRefs: [runtimeRefs[3]],
		filesChanged: ["src/a.ts"],
		review: { verdict: "APPROVE", findings: ["none"] },
	};
	const plan = adaptChildStructuredResult(source as ReturnType<typeof result>, childId, runtimeRefs)!;
	source.artifactRefs[0] = "mutated";
	source.filesChanged[0] = "mutated";
	source.review.findings[0] = "mutated";
	assert.deepEqual(plan, {
		facts: [
			{ kind: "workspace.changed", payload: { childId, files: ["src/a.ts"] } },
			{ kind: "review.completed", payload: { childId, verdict: "APPROVE", findings: ["none"] } },
		],
		terminalFields: { resultArtifactRefs: [runtimeRefs[3]] },
	});
});
