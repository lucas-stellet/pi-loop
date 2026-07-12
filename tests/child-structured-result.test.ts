import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "typebox/value";

import {
	CHILD_STRUCTURED_RESULT_SCHEMA,
	MAX_CHILD_STRUCTURED_RESULT_BYTES,
	createChildStructuredResultCandidate,
	parseChildStructuredResult,
	validateChildStructuredResult,
} from "../src/child-structured-result.ts";

const allFields = {
	summary: "kept exactly  ",
	artifactRefs: ["children/a"],
	filesChanged: ["src/a.ts"],
	validations: [{ command: "npm test", outcome: "passed" }],
	review: { verdict: "APPROVE", findings: ["none"] },
	nits: ["minor"],
	blockers: ["none"],
	confidence: 1,
	classification: "complete",
};

function parse(value: unknown) {
	return parseChildStructuredResult(Buffer.from(JSON.stringify(value), "utf8"));
}

test("advertises the one strict result schema with every optional field and exact limits", () => {
	assert.equal(CHILD_STRUCTURED_RESULT_SCHEMA.additionalProperties, false);
	assert.deepEqual(Object.keys(CHILD_STRUCTURED_RESULT_SCHEMA.properties).sort(), [
		"artifactRefs", "blockers", "classification", "confidence", "filesChanged", "nits", "review", "summary", "validations",
	]);
	assert.deepEqual(CHILD_STRUCTURED_RESULT_SCHEMA.required, undefined);
	assert.equal(Check(CHILD_STRUCTURED_RESULT_SCHEMA, {}), true);
	assert.equal(Check(CHILD_STRUCTURED_RESULT_SCHEMA, allFields), true);
	assert.equal(Check(CHILD_STRUCTURED_RESULT_SCHEMA, { unknown: true }), false);
	assert.equal(Check(CHILD_STRUCTURED_RESULT_SCHEMA, { validations: [{ command: "ok", outcome: "ok", extra: true }] }), false);
	assert.equal(Check(CHILD_STRUCTURED_RESULT_SCHEMA, { review: { verdict: "ok", findings: [], extra: true } }), false);
});

test("parses only complete strict, semantically valid objects and preserves accepted strings", () => {
	assert.deepEqual(parse({}), {});
	assert.deepEqual(parse(allFields), allFields);
	for (const value of [
		null, [], { unknown: true }, { summary: " \t\n" }, { summary: "x".repeat(4097) },
		{ summary: "😀".repeat(2049) }, { artifactRefs: Array(101).fill("a") },
		{ validations: [{ command: "ok", outcome: "ok", extra: true }] },
		{ review: { verdict: "ok", findings: ["ok"], extra: true } },
		// Non-finite numbers cannot round-trip through JSON; direct validator tests cover them.
		{ confidence: -0.01 }, { confidence: 1.01 }, { confidence: null },
	]) assert.equal(parse(value), undefined, JSON.stringify(value));
	assert.deepEqual(parse({ summary: "😀".repeat(2048) }), { summary: "😀".repeat(2048) });
	for (const value of [
		{ artifactRefs: [" "] }, { filesChanged: [" "] }, { nits: [" "] }, { blockers: [" "] },
		{ validations: [{ command: " ", outcome: "ok" }] }, { validations: [{ command: "ok", outcome: " " }] },
		{ review: { verdict: " ", findings: [] } }, { review: { verdict: "ok", findings: [" "] } },
		{ filesChanged: Array(101).fill("a") }, { validations: Array(101).fill({ command: "a", outcome: "a" }) },
		{ review: { verdict: "ok", findings: Array(101).fill("a") } }, { nits: Array(101).fill("a") }, { blockers: Array(101).fill("a") },
		{ classification: "x".repeat(4097) }, { artifactRefs: ["x".repeat(4097)] },
	]) assert.equal(parse(value), undefined, JSON.stringify(value));
	assert.equal(parseChildStructuredResult(Buffer.from('{"summary":"ok"} trailing')), undefined);
	assert.equal(parseChildStructuredResult(Buffer.from('{"summary":"ok"}{"summary":"again"}')), undefined);
	assert.equal(parseChildStructuredResult(Buffer.from('{"summary":')), undefined);
	assert.equal(parseChildStructuredResult(Buffer.from([0xff])), undefined);
});

test("bounds authority by original fd-3 bytes while allowing arbitrary chunk boundaries", () => {
	const candidate = createChildStructuredResultCandidate();
	for (const byte of Buffer.from(JSON.stringify({ summary: "split" }))) candidate.write(Buffer.from([byte]));
	assert.deepEqual(candidate.finish(), { summary: "split" });

	const exactDocument = Buffer.from('{"summary":"a"}');
	const padding = Buffer.alloc(MAX_CHILD_STRUCTURED_RESULT_BYTES - exactDocument.length, 0x20);
	const exact = createChildStructuredResultCandidate();
	exact.write(exactDocument);
	exact.write(padding);
	assert.equal(exact.finish()?.summary, "a");

	const overSingle = createChildStructuredResultCandidate();
	overSingle.write(Buffer.alloc(MAX_CHILD_STRUCTURED_RESULT_BYTES + 1, 0x61));
	assert.equal(overSingle.finish(), undefined);

	const overAcrossChunks = createChildStructuredResultCandidate();
	overAcrossChunks.write(exactDocument);
	overAcrossChunks.write(padding);
	overAcrossChunks.write(Buffer.from([0x20]));
	assert.equal(overAcrossChunks.finish(), undefined);
	assert.equal(parseChildStructuredResult(Buffer.alloc(0)), undefined);
});

test("direct validator enforces finite inclusive confidence bounds", () => {
	for (const confidence of [Number.NaN, Infinity, -Infinity, -0.01, 1.01]) {
		assert.equal(validateChildStructuredResult({ confidence }), undefined);
	}
	assert.deepEqual(validateChildStructuredResult({ confidence: 0 }), { confidence: 0 });
	assert.deepEqual(validateChildStructuredResult({ confidence: 1 }), { confidence: 1 });
});

test("direct validator enforces every string boundary and preserves accepted values", () => {
	const cases: Array<[string, (value: string) => unknown]> = [
		["summary", (value) => ({ summary: value })],
		["artifact reference", (value) => ({ artifactRefs: [value] })],
		["file", (value) => ({ filesChanged: [value] })],
		["validation command", (value) => ({ validations: [{ command: value, outcome: "ok" }] })],
		["validation outcome", (value) => ({ validations: [{ command: "ok", outcome: value }] })],
		["review verdict", (value) => ({ review: { verdict: value, findings: [] } })],
		["review finding", (value) => ({ review: { verdict: "ok", findings: [value] } })],
		["nit", (value) => ({ nits: [value] })],
		["blocker", (value) => ({ blockers: [value] })],
		["classification", (value) => ({ classification: value })],
	];
	for (const [location, makeValue] of cases) {
		const accepted = `${location}:${"x".repeat(4096 - location.length - 1)}`;
		assert.deepEqual(validateChildStructuredResult(makeValue(accepted)), makeValue(accepted), location);
		for (const invalid of ["", " \t\n", "x".repeat(4097)]) {
			assert.equal(validateChildStructuredResult(makeValue(invalid)), undefined, `${location}: ${JSON.stringify(invalid)}`);
		}
	}
});

test("direct validator enforces exact list bounds and nested record strictness", () => {
	const cases: Array<[string, (items: number) => unknown]> = [
		["artifactRefs", (items) => ({ artifactRefs: Array(items).fill("a") })],
		["filesChanged", (items) => ({ filesChanged: Array(items).fill("a") })],
		["validations", (items) => ({ validations: Array(items).fill({ command: "a", outcome: "a" }) })],
		["review.findings", (items) => ({ review: { verdict: "ok", findings: Array(items).fill("a") } })],
		["nits", (items) => ({ nits: Array(items).fill("a") })],
		["blockers", (items) => ({ blockers: Array(items).fill("a") })],
	];
	for (const [location, makeValue] of cases) {
		assert.notEqual(validateChildStructuredResult(makeValue(100)), undefined, location);
		assert.equal(validateChildStructuredResult(makeValue(101)), undefined, location);
	}
	for (const value of [
		{ validations: [{}] },
		{ validations: [{ command: "ok" }] },
		{ validations: [{ outcome: "ok" }] },
		{ validations: [{ command: "ok", outcome: "ok", extra: true }] },
		{ review: {} },
		{ review: { findings: [] } },
		{ review: { verdict: "ok" } },
		{ review: { verdict: "ok", findings: [], extra: true } },
	]) assert.equal(validateChildStructuredResult(value), undefined);
});

test("returns fully frozen detached authority that resists mutation", () => {
	const source = structuredClone(allFields);
	const result = parse(source)!;
	for (const value of [
		result, result.artifactRefs, result.filesChanged, result.validations, result.validations![0],
		result.review, result.review!.findings, result.nits, result.blockers,
	]) assert.ok(Object.isFrozen(value));
	assert.throws(() => (result.artifactRefs as string[]).push("mutate"));
	assert.throws(() => (result.filesChanged as string[]).push("mutate"));
	assert.throws(() => (result.validations as { command: string; outcome: string }[]).push({ command: "mutate", outcome: "mutate" }));
	assert.throws(() => (result.validations![0] as { command: string }).command = "mutate");
	assert.throws(() => (result.review!.findings as string[]).push("mutate"));
	assert.throws(() => (result.nits as string[]).push("mutate"));
	assert.throws(() => (result.blockers as string[]).push("mutate"));
	assert.deepEqual(result, allFields);
	assert.notEqual(result.artifactRefs, source.artifactRefs);
});
