export type ProjectableEvent = {
	schemaVersion: 1;
	runId: string;
	sequence: number;
	timestamp: number;
	kind: string;
	payload: Record<string, unknown>;
};

export type EventReference = {
	runId: string;
	sequence: number;
};

export type InvalidFactCode =
	| "cross-run-reference"
	| "missing-reference"
	| "invalid-causal-order"
	| "malformed-reference"
	| "malformed-payload"
	| "resume-before-pause"
	| "pause-when-not-active"
	| "duplicate-start"
	| "conflicting-settlement"
	| "lifecycle-after-settlement";

export type InvalidFact = {
	code: InvalidFactCode;
	sequence: number;
};

export type UnresolvedFact = {
	code: InvalidFactCode;
	sequence: number;
};

export type RequirementGroup = {
	eventSequences: number[];
};

export type EventProjection = {
	lifecycle: { state: string; settlement: string | undefined; highWater: number };
	iteration: { used: number; max: number | undefined };
	budget: { tokensUsed: number; tokensMax: number | undefined };
	delegations: { sequence: number; childId: string; status: string; artifactRefs: string[] }[];
	validations: { sequence: number; command: string; outcome: string }[];
	reviews: { sequence: number; verdict: string; findings: string[] }[];
	workspaceChanges: { sequence: number; files: string[] }[];
	blockers: { sequence: number; message: string }[];
	failures: { sequence: number; message: string }[];
	retries: { sequence: number; attempt: number; reason: string | undefined }[];
	nits: { sequence: number; message: string }[];
	assessments: { sequence: number; requirementId: string; verdict: string; references: number[] }[];
	requirements: Record<string, RequirementGroup>;
	unresolvedFacts: UnresolvedFact[];
	invalidFacts: InvalidFact[];
};

/** True terminal settlements — pause is not terminal. */
const TERMINAL_BY_KIND: Record<string, string> = {
	"loop.completed": "completed",
	"loop.failed": "failed",
	"loop.cleared": "cleared",
	"loop.budget_limited": "budget_limited",
};

const LIFECYCLE_KINDS = new Set([
	"loop.started",
	"loop.paused",
	"loop.resumed",
	"loop.completed",
	"loop.failed",
	"loop.cleared",
	"loop.budget_limited",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	if (!value.every((item): item is string => typeof item === "string")) {
		return undefined;
	}
	return value;
}

function emptyProjection(): EventProjection {
	return {
		lifecycle: { state: "idle", settlement: undefined, highWater: 0 },
		iteration: { used: 0, max: undefined },
		budget: { tokensUsed: 0, tokensMax: undefined },
		delegations: [],
		validations: [],
		reviews: [],
		workspaceChanges: [],
		blockers: [],
		failures: [],
		retries: [],
		nits: [],
		assessments: [],
		// Prototype-safe map so opaque ids like "__proto__" never pollute Object.prototype.
		requirements: Object.create(null) as Record<string, RequirementGroup>,
		unresolvedFacts: [],
		invalidFacts: [],
	};
}

function pushDiagnostic(projection: EventProjection, code: InvalidFactCode, sequence: number): void {
	const fact = { code, sequence };
	projection.invalidFacts.push(fact);
	if (
		code === "cross-run-reference" ||
		code === "missing-reference" ||
		code === "invalid-causal-order" ||
		code === "malformed-reference"
	) {
		projection.unresolvedFacts.push(fact);
	}
}

function requirementIdsFrom(payload: Record<string, unknown>): string[] {
	const ids: string[] = [];
	const multi = payload.requirementIds;
	if (Array.isArray(multi)) {
		for (const item of multi) {
			if (typeof item === "string") {
				ids.push(item);
			}
		}
	}
	const single = asString(payload.requirementId);
	if (single !== undefined) {
		ids.push(single);
	}
	return ids;
}

function parseReferences(
	projection: EventProjection,
	sourceSequence: number,
	value: unknown,
): EventReference[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		pushDiagnostic(projection, "malformed-reference", sourceSequence);
		return [];
	}

	const references: EventReference[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.runId !== "string" || typeof item.sequence !== "number") {
			pushDiagnostic(projection, "malformed-reference", sourceSequence);
			continue;
		}
		references.push({ runId: item.runId, sequence: item.sequence });
	}
	return references;
}

function recordReferenceDiagnostics(
	projection: EventProjection,
	runId: string,
	sourceSequence: number,
	references: EventReference[],
	knownSequences: Set<number>,
): void {
	for (const reference of references) {
		if (reference.runId !== runId) {
			pushDiagnostic(projection, "cross-run-reference", sourceSequence);
		} else if (!knownSequences.has(reference.sequence)) {
			pushDiagnostic(projection, "missing-reference", sourceSequence);
		} else if (reference.sequence >= sourceSequence) {
			pushDiagnostic(projection, "invalid-causal-order", sourceSequence);
		}
	}
}

function applyLifecycle(
	projection: EventProjection,
	event: ProjectableEvent,
	lifecycleState: string,
	settledTerminal: string | undefined,
): { lifecycleState: string; settledTerminal: string | undefined } {
	const { kind, sequence, payload } = event;

	if (settledTerminal !== undefined) {
		if (TERMINAL_BY_KIND[kind] !== undefined && TERMINAL_BY_KIND[kind] !== settledTerminal) {
			pushDiagnostic(projection, "conflicting-settlement", sequence);
		} else if (LIFECYCLE_KINDS.has(kind)) {
			pushDiagnostic(projection, "lifecycle-after-settlement", sequence);
		}
		return { lifecycleState, settledTerminal };
	}

	const terminal = TERMINAL_BY_KIND[kind];
	if (terminal !== undefined) {
		if (lifecycleState === "idle" && kind !== "loop.cleared") {
			// Clearing from idle is a no-op terminal; other terminals without start are contradictory but still settle.
		}
		projection.lifecycle.state = terminal;
		projection.lifecycle.settlement = terminal;
		return { lifecycleState: terminal, settledTerminal: terminal };
	}

	switch (kind) {
		case "loop.started": {
			if (lifecycleState !== "idle") {
				pushDiagnostic(projection, "duplicate-start", sequence);
				return { lifecycleState, settledTerminal };
			}
			projection.lifecycle.state = "active";
			projection.iteration.max = asNumber(payload.maxIterations) ?? projection.iteration.max;
			projection.budget.tokensMax = asNumber(payload.tokenBudget) ?? asNumber(payload.maxTokens) ?? projection.budget.tokensMax;
			return { lifecycleState: "active", settledTerminal };
		}
		case "loop.paused": {
			if (lifecycleState !== "active") {
				pushDiagnostic(projection, "pause-when-not-active", sequence);
				return { lifecycleState, settledTerminal };
			}
			projection.lifecycle.state = "paused";
			return { lifecycleState: "paused", settledTerminal };
		}
		case "loop.resumed": {
			if (lifecycleState !== "paused") {
				pushDiagnostic(projection, "resume-before-pause", sequence);
				return { lifecycleState, settledTerminal };
			}
			projection.lifecycle.state = "active";
			return { lifecycleState: "active", settledTerminal };
		}
		default:
			return { lifecycleState, settledTerminal };
	}
}

function applyFact(projection: EventProjection, event: ProjectableEvent, references: EventReference[]): void {
	const { kind, sequence, payload } = event;

	switch (kind) {
		case "loop.iteration": {
			const used = asNumber(payload.used);
			if (used === undefined) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.iteration.used = used;
			return;
		}
		case "budget.updated": {
			const tokensUsed = asNumber(payload.tokensUsed);
			if (tokensUsed === undefined) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.budget.tokensUsed = tokensUsed;
			const tokensMax = asNumber(payload.tokensMax);
			if (tokensMax !== undefined) {
				projection.budget.tokensMax = tokensMax;
			}
			return;
		}
		case "delegation.updated": {
			const childId = asString(payload.childId);
			const status = asString(payload.status);
			const artifactRefs = asStringArray(payload.artifactRefs);
			if (!childId || !status || artifactRefs === undefined) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.delegations.push({ sequence, childId, status, artifactRefs });
			return;
		}
		case "validation.completed": {
			const command = asString(payload.command);
			const outcome = asString(payload.outcome);
			if (!command || !outcome) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.validations.push({ sequence, command, outcome });
			return;
		}
		case "review.completed": {
			const verdict = asString(payload.verdict);
			const findings = asStringArray(payload.findings);
			if (!verdict || findings === undefined) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.reviews.push({ sequence, verdict, findings });
			return;
		}
		case "workspace.changed": {
			const files = asStringArray(payload.files);
			if (files === undefined) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.workspaceChanges.push({ sequence, files });
			return;
		}
		case "blocker.raised": {
			const message = asString(payload.message);
			if (!message) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.blockers.push({ sequence, message });
			return;
		}
		case "failure.recorded": {
			const message = asString(payload.message);
			if (!message) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.failures.push({ sequence, message });
			return;
		}
		case "retry.recorded": {
			const attempt = asNumber(payload.attempt);
			if (attempt === undefined) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.retries.push({ sequence, attempt, reason: asString(payload.reason) });
			return;
		}
		case "nit.recorded": {
			const message = asString(payload.message);
			if (!message) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.nits.push({ sequence, message });
			return;
		}
		case "supervisor.assessment": {
			const requirementId = asString(payload.requirementId);
			const verdict = asString(payload.verdict);
			if (!requirementId || !verdict) {
				pushDiagnostic(projection, "malformed-payload", sequence);
				return;
			}
			projection.assessments.push({
				sequence,
				requirementId,
				verdict,
				references: references.map((reference) => reference.sequence),
			});
			return;
		}
	}
}

export function projectEvents({ runId, events }: { runId: string; events: readonly ProjectableEvent[] }): EventProjection {
	// Filter to the active run before building indexes so foreign envelopes cannot satisfy refs or high-water.
	const activeEvents = events.filter((event) => event.runId === runId);
	const knownSequences = new Set(activeEvents.map((event) => event.sequence));
	const projection = emptyProjection();
	let lifecycleState = "idle";
	let settledTerminal: string | undefined;

	if (activeEvents.length > 0) {
		projection.lifecycle.highWater = Math.max(...activeEvents.map((event) => event.sequence));
	}

	for (const event of activeEvents) {
		const references = parseReferences(projection, event.sequence, event.payload.references);
		recordReferenceDiagnostics(projection, runId, event.sequence, references, knownSequences);

		for (const requirementId of requirementIdsFrom(event.payload)) {
			const group = projection.requirements[requirementId] ?? { eventSequences: [] };
			group.eventSequences.push(event.sequence);
			projection.requirements[requirementId] = group;
		}

		if (LIFECYCLE_KINDS.has(event.kind)) {
			({ lifecycleState, settledTerminal } = applyLifecycle(projection, event, lifecycleState, settledTerminal));
			continue;
		}

		applyFact(projection, event, references);
	}

	return projection;
}

function factLines(projection: EventProjection): string[] {
	return [
		"Loop decision context",
		`Lifecycle: ${projection.lifecycle.state}${projection.lifecycle.settlement ? ` settlement=${projection.lifecycle.settlement}` : ""} highWater=${projection.lifecycle.highWater}`,
		`Iteration: ${projection.iteration.used}${projection.iteration.max === undefined ? "" : `/${projection.iteration.max}`}`,
		`Budget: ${projection.budget.tokensUsed}${projection.budget.tokensMax === undefined ? "" : `/${projection.budget.tokensMax}`}`,
		...projection.delegations.map(
			(fact) =>
				`#${fact.sequence} delegation ${fact.childId}: ${fact.status}; artifacts ${fact.artifactRefs.join(", ") || "(none)"}`,
		),
		...projection.validations.map((fact) => `#${fact.sequence} validation ${fact.command}: ${fact.outcome}`),
		...projection.reviews.map(
			(fact) =>
				`#${fact.sequence} review: ${fact.verdict}; findings ${fact.findings.join(", ") || "(none)"}`,
		),
		...projection.workspaceChanges.map(
			(fact) => `#${fact.sequence} workspace: ${fact.files.join(", ") || "(none)"}`,
		),
		...projection.blockers.map((fact) => `#${fact.sequence} blocker: ${fact.message}`),
		...projection.failures.map((fact) => `#${fact.sequence} failure: ${fact.message}`),
		...projection.retries.map(
			(fact) =>
				`#${fact.sequence} retry attempt ${fact.attempt}${fact.reason ? `: ${fact.reason}` : ""}`,
		),
		...projection.nits.map((fact) => `#${fact.sequence} nit: ${fact.message}`),
		...projection.assessments.map(
			(fact) =>
				`#${fact.sequence} assessment ${fact.requirementId}: ${fact.verdict}; refs ${fact.references.join(", ") || "(none)"}`,
		),
		...Object.keys(projection.requirements).map((requirementId) => {
			const group = projection.requirements[requirementId]!;
			return `requirement ${requirementId}: seq ${group.eventSequences.join(", ")}`;
		}),
		...projection.unresolvedFacts.map((fact) => `#${fact.sequence} unresolved: ${fact.code}`),
		...projection.invalidFacts.map((fact) => `#${fact.sequence} invalid: ${fact.code}`),
	];
}

/**
 * Render a bounded, whitelist-only decision context.
 * Whole lines only — never mid-value truncation of identifiers/references.
 */
export function renderDecisionContext(
	projection: EventProjection,
	{ maxCharacters }: { maxCharacters: number },
): string {
	if (maxCharacters <= 0) {
		return "";
	}

	const lines = factLines(projection);
	const selected: string[] = [];
	let used = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const remaining = lines.length - index - 1;
		const separator = selected.length === 0 ? 0 : 1;
		const nextLength = used + separator + line.length;

		if (remaining === 0) {
			if (nextLength <= maxCharacters) {
				selected.push(line);
				used = nextLength;
			}
			break;
		}

		// Reserve room for an omission marker when later lines may not fit.
		const omission = `…(${remaining} more)`;
		const withOmission = nextLength + 1 + omission.length;
		if (withOmission <= maxCharacters) {
			selected.push(line);
			used = nextLength;
			continue;
		}

		// Current line does not leave room for a later omission; try including it as last line.
		if (nextLength <= maxCharacters && remaining === 0) {
			selected.push(line);
			used = nextLength;
			break;
		}

		// Stop before this line; emit omission for everything from here if it fits.
		const omitted = lines.length - index;
		const marker = `…(${omitted} more)`;
		const markerLength = (selected.length === 0 ? 0 : 1) + marker.length;
		if (used + markerLength <= maxCharacters) {
			selected.push(marker);
		}
		break;
	}

	// If nothing fit except possibly a pure omission marker.
	if (selected.length === 0 && lines.length > 0) {
		const marker = `…(${lines.length} more)`;
		return marker.length <= maxCharacters ? marker : "";
	}

	const context = selected.join("\n");
	return context.length <= maxCharacters ? context : "";
}

/** Project journal events for the active run into supervisor decision context. */
export function projectRunContext({
	runId,
	events,
	maxCharacters = 4000,
}: {
	runId: string;
	events: readonly ProjectableEvent[];
	maxCharacters?: number;
}): { projection: EventProjection; context: string } {
	const projection = projectEvents({ runId, events });
	return {
		projection,
		context: renderDecisionContext(projection, { maxCharacters }),
	};
}
