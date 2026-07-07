export function requirementsFromObjective(objective: string): string[] {
	const numbered = objective
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^\d+\.\s+/.test(line));

	return numbered.length > 0 ? numbered : [objective.trim()].filter(Boolean);
}

export function validateCompletionSummary(requirements: string[], summary: string): string | undefined {
	if (summary.length === 0) {
		return "Completion summary is empty.";
	}

	if (hasContradiction(summary)) {
		return "Completion summary is contradictory.";
	}

	return missingEvidence(requirements, summary);
}

export function summaryReportsFailure(summary: string): boolean {
	return /\b(failed|failing)\b/i.test(summary);
}

function hasContradiction(summary: string): boolean {
	return /\b(not complete|incomplete|unverified)\b/i.test(summary) || summaryReportsFailure(summary);
}

function missingEvidence(requirements: string[], summary: string): string | undefined {
	for (let index = 0; index < requirements.length; index += 1) {
		const requirementNumber = index + 1;
		const mentionsRequirement = new RegExp(`Requirement\\s+${requirementNumber}\\b`, "i").test(summary);
		if (!mentionsRequirement) {
			return `Requirement ${requirementNumber} is missing evidence.`;
		}
	}

	if (!/\bevidence\b/i.test(summary)) {
		return "Completion summary is missing evidence.";
	}

	return undefined;
}
