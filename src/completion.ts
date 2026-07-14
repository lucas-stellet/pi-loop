import { LOOP_CONTROL_FILES } from "./constants.ts";
import { readControlFile } from "./control-files.ts";

export type CompletionEvidenceContext = {
	cwd: string;
	runId?: string;
	/** Sequences known to belong to the active run's journal. */
	knownEventSequences?: ReadonlySet<number>;
};

type JournalEvidenceEvent = {
	runId?: string;
	sequence: number;
	kind: string;
	payload: Record<string, unknown>;
};

const SEMANTIC_COMPLETION_KINDS = new Set([
	"workspace.changed",
	"validation.completed",
	"review.completed",
	"nit.recorded",
	"blocker.raised",
	"failure.recorded",
	"retry.recorded",
]);

/**
 * Sequences that may ground completion summary/assessment evidence.
 * Only current-run members of the closed typed-fact allowlist, plus
 * `delegation.updated` with exact status `completed`, qualify. Undefined active
 * run identity fails closed.
 */
export function semanticCompletionSequences(
	events: readonly JournalEvidenceEvent[],
	runId: string | undefined,
): Set<number> {
	if (runId === undefined) {
		return new Set();
	}

	return new Set(
		events
			.filter(
				(event) =>
					event.runId === runId &&
					(SEMANTIC_COMPLETION_KINDS.has(event.kind) ||
						(event.kind === "delegation.updated" && event.payload.status === "completed")),
			)
			.map((event) => event.sequence),
	);
}

export type RequirementAssessmentInput = {
	requirementId: string;
	verdict: string;
	eventSequences: number[];
};

export function requirementsFromObjective(objective: string): string[] {
	const numbered = objective
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^\d+\.\s+/.test(line));

	return numbered.length > 0 ? numbered : [objective.trim()].filter(Boolean);
}

export async function validateCompletionSummary(
	requirements: string[],
	summary: string,
	evidence: CompletionEvidenceContext,
): Promise<string | undefined> {
	if (summary.length === 0) {
		return "Completion summary is empty.";
	}

	if (hasContradiction(summary)) {
		return "Completion summary is contradictory.";
	}

	return missingEvidence(requirements, summary, evidence);
}

/**
 * Validate a one-to-one mapping between projected requirements and assessments,
 * then check that the sole match for each requirement cites current-run sequences.
 * Rejects missing, duplicate (including alias collisions), unknown, and ambiguous
 * assessments. Does not judge semantic sufficiency of verdicts.
 */
export function validateAssessmentProvenance(
	requirements: string[],
	assessments: RequirementAssessmentInput[],
	knownEventSequences: ReadonlySet<number>,
): string | undefined {
	if (requirements.length === 0) {
		return undefined;
	}

	if (assessments.length === 0) {
		return "Completion assessments are missing.";
	}

	for (const assessment of assessments) {
		const matches = requirements.filter((requirement, index) =>
			assessmentCoversRequirement(assessment, index, requirement),
		);
		if (matches.length === 0) {
			return `Unknown requirement assessment ${assessment.requirementId.trim()}.`;
		}
		if (matches.length > 1) {
			return `Assessment ${assessment.requirementId.trim()} matches multiple requirements.`;
		}
	}

	for (let index = 0; index < requirements.length; index += 1) {
		const requirement = requirements[index]!;
		const matches = assessments.filter((assessment) =>
			assessmentCoversRequirement(assessment, index, requirement),
		);
		if (matches.length === 0) {
			return `Requirement ${index + 1} is missing an assessment.`;
		}
		if (matches.length > 1) {
			return `Requirement ${index + 1} has a duplicate assessment.`;
		}
		const assessment = matches[0]!;
		if (!assessment.verdict.trim()) {
			return `Requirement ${index + 1} assessment is missing a verdict.`;
		}
		if (assessment.eventSequences.length === 0) {
			return `Requirement ${index + 1} assessment is missing event references.`;
		}
		for (const sequence of assessment.eventSequences) {
			if (!knownEventSequences.has(sequence)) {
				return `Requirement ${index + 1} cites missing or cross-run event sequence ${sequence}.`;
			}
		}
	}

	return undefined;
}

export function summaryReportsFailure(summary: string): boolean {
	return /\b(failed|failing)\b/i.test(summary);
}

function assessmentCoversRequirement(
	assessment: RequirementAssessmentInput,
	index: number,
	requirement: string,
): boolean {
	const id = assessment.requirementId.trim();
	return id === String(index + 1) || id === `REQ-${index + 1}` || id === requirement;
}

function hasContradiction(summary: string): boolean {
	return /\b(not complete|incomplete|unverified)\b/i.test(summary) || summaryReportsFailure(summary);
}

async function missingEvidence(
	requirements: string[],
	summary: string,
	evidence: CompletionEvidenceContext,
): Promise<string | undefined> {
	const sections = requirementSections(summary);

	for (let index = 0; index < requirements.length; index += 1) {
		const requirementNumber = index + 1;
		const section = sections.get(requirementNumber);
		if (!section || !(await hasGroundedEvidence(section, evidence))) {
			return `Requirement ${requirementNumber} is missing evidence.`;
		}
	}

	return undefined;
}

function requirementSections(summary: string): Map<number, string> {
	const markers = [...summary.matchAll(/Requirement\s+(\d+)\b/gi)];
	const sections = new Map<number, string>();

	for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
		const requirementNumber = Number(markers[markerIndex]![1]);
		if (sections.has(requirementNumber)) {
			continue;
		}

		const start = markers[markerIndex]!.index ?? 0;
		const end = markers[markerIndex + 1]?.index ?? summary.length;
		sections.set(requirementNumber, summary.slice(start, end));
	}

	return sections;
}

async function hasGroundedEvidence(section: string, evidence: CompletionEvidenceContext): Promise<boolean> {
	// Event-sequence citations like #3 or seq:3 from the projected context.
	if (evidence.knownEventSequences && evidence.knownEventSequences.size > 0) {
		const cited = [...section.matchAll(/(?:#|seq:)\s*(\d+)\b/gi)].map((match) => Number(match[1]));
		if (cited.length > 0 && cited.every((sequence) => evidence.knownEventSequences!.has(sequence))) {
			return true;
		}
	}

	if (!evidence.runId) {
		return false;
	}

	for (const file of LOOP_CONTROL_FILES) {
		if (!citesControlFile(section, file)) {
			continue;
		}
		if ((await readControlFile(evidence.cwd, evidence.runId, file)) !== undefined) {
			return true;
		}
	}

	return false;
}

function citesControlFile(section: string, file: string): boolean {
	const tokens = section.match(/[A-Za-z0-9._/-]+/g) ?? [];
	return tokens.some((token) => token.replace(/[.,;:!?]+$/, "") === file);
}
