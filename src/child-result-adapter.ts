import type { ChildStructuredResult } from "./child-structured-result.ts";

export type ChildResultFact = Readonly<{
	kind: "workspace.changed" | "validation.completed" | "review.completed" | "nit.recorded" | "blocker.raised";
	payload: Record<string, unknown>;
}>;

export type ChildResultAdaptationPlan = Readonly<{
	facts: readonly ChildResultFact[];
	terminalFields: Record<string, unknown>;
}>;

export function adaptChildStructuredResult(
	result: ChildStructuredResult,
	childId: string,
	runtimeRefs: readonly string[],
): ChildResultAdaptationPlan | undefined {
	if (!runtimeRefs.includes(`children/${childId}/structured.bin`)) {
		return undefined;
	}
	if (result.artifactRefs) {
		const uniqueReported = new Set(result.artifactRefs);
		const hasDuplicate = uniqueReported.size !== result.artifactRefs.length;
		const hasNonMember = result.artifactRefs.some((ref) => !runtimeRefs.includes(ref));
		if (hasDuplicate || hasNonMember) {
			return undefined;
		}
	}

	const facts: ChildResultFact[] = [];
	if (result.filesChanged?.length) {
		facts.push({ kind: "workspace.changed", payload: { childId, files: [...result.filesChanged] } });
	}
	for (const validation of result.validations ?? []) {
		facts.push({
			kind: "validation.completed",
			payload: { childId, command: validation.command, outcome: validation.outcome },
		});
	}
	if (result.review) {
		facts.push({
			kind: "review.completed",
			payload: { childId, verdict: result.review.verdict, findings: [...result.review.findings] },
		});
	}
	for (const message of result.nits ?? []) {
		facts.push({ kind: "nit.recorded", payload: { childId, message } });
	}
	for (const message of result.blockers ?? []) {
		facts.push({ kind: "blocker.raised", payload: { childId, message } });
	}

	const terminalFields: Record<string, unknown> = {};
	if (Object.hasOwn(result, "summary")) {
		terminalFields.summary = result.summary;
	}
	if (Object.hasOwn(result, "confidence")) {
		terminalFields.confidence = result.confidence;
	}
	if (Object.hasOwn(result, "classification")) {
		terminalFields.classification = result.classification;
	}
	if (Object.hasOwn(result, "artifactRefs")) {
		terminalFields.resultArtifactRefs = [...(result.artifactRefs ?? [])];
	}
	return { facts, terminalFields };
}
