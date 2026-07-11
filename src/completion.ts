import { LOOP_CONTROL_FILES } from "./constants.ts";
import { readControlFile } from "./control-files.ts";

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

type DelegationData = {
	runId?: unknown;
	task?: unknown;
	name?: unknown;
	target?: unknown;
};

export type CompletionEvidenceContext = {
	cwd: string;
	runId?: string;
	entries: unknown[];
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

export function summaryReportsFailure(summary: string): boolean {
	return /\b(failed|failing)\b/i.test(summary);
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
	const delegationCitations = currentRunDelegationCitations(evidence.entries, evidence.runId);

	for (let index = 0; index < requirements.length; index += 1) {
		const requirementNumber = index + 1;
		const section = sections.get(requirementNumber);
		if (!section || !(await hasGroundedEvidence(section, evidence, delegationCitations))) {
			return `Requirement ${requirementNumber} is missing evidence.`;
		}
	}

	return undefined;
}

function requirementSections(summary: string): Map<number, string> {
	const markers = [...summary.matchAll(/Requirement\s+(\d+)\b/gi)];
	const sections = new Map<number, string>();

	for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
		const requirementNumber = Number(markers[markerIndex][1]);
		if (sections.has(requirementNumber)) {
			continue;
		}

		const start = markers[markerIndex].index ?? 0;
		const end = markers[markerIndex + 1]?.index ?? summary.length;
		sections.set(requirementNumber, summary.slice(start, end));
	}

	return sections;
}

async function hasGroundedEvidence(
	section: string,
	evidence: CompletionEvidenceContext,
	delegationCitations: string[],
): Promise<boolean> {
	if (delegationCitations.some((value) => section.includes(value))) {
		return true;
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

function currentRunDelegationCitations(entries: unknown[], runId: string | undefined): string[] {
	if (!runId) {
		return [];
	}

	const citations: string[] = [];
	for (const candidate of entries) {
		const entry = candidate as SessionEntry;
		if (entry.type !== "custom" || entry.customType !== "loop-delegation") {
			continue;
		}

		const data = entry.data as DelegationData | undefined;
		if (data?.runId !== runId) {
			continue;
		}

		for (const value of [data.task, data.name, data.target]) {
			if (typeof value === "string" && value.trim().length > 0) {
				citations.push(value);
			}
		}
	}

	return citations;
}
