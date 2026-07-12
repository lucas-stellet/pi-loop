import { Type } from "typebox";

export const MAX_CHILD_STRUCTURED_RESULT_BYTES = 256 * 1024;

const MAX_STRING_LENGTH = 4096;
const MAX_LIST_ITEMS = 100;
const RESULT_KEYS = [
	"summary",
	"artifactRefs",
	"filesChanged",
	"validations",
	"review",
	"nits",
	"blockers",
	"confidence",
	"classification",
] as const;
const STRING_LIST_KEYS = ["artifactRefs", "filesChanged", "nits", "blockers"] as const;

const resultString = Type.String({ minLength: 1, maxLength: MAX_STRING_LENGTH, pattern: ".*\\S.*" });
const resultStrings = Type.Array(resultString, { maxItems: MAX_LIST_ITEMS });

const childStructuredResultSchema = Type.Object(
	{
		summary: Type.Optional(resultString),
		artifactRefs: Type.Optional(resultStrings),
		filesChanged: Type.Optional(resultStrings),
		validations: Type.Optional(
			Type.Array(
				Type.Object(
					{
						command: resultString,
						outcome: resultString,
					},
					{ additionalProperties: false },
				),
				{ maxItems: MAX_LIST_ITEMS },
			),
		),
		review: Type.Optional(
			Type.Object(
				{
					verdict: resultString,
					findings: resultStrings,
				},
				{ additionalProperties: false },
			),
		),
		nits: Type.Optional(resultStrings),
		blockers: Type.Optional(resultStrings),
		confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		classification: Type.Optional(resultString),
	},
	{ additionalProperties: false },
);

// TypeBox's static TObject type omits additionalProperties; retain the runtime flag for schema inspection.
export const CHILD_STRUCTURED_RESULT_SCHEMA = childStructuredResultSchema as typeof childStructuredResultSchema & {
	additionalProperties: false;
};

export type ChildStructuredResult = Readonly<{
	summary?: string;
	artifactRefs?: readonly string[];
	filesChanged?: readonly string[];
	validations?: readonly Readonly<{ command: string; outcome: string }>[];
	review?: Readonly<{ verdict: string; findings: readonly string[] }>;
	nits?: readonly string[];
	blockers?: readonly string[];
	confidence?: number;
	classification?: string;
}>;

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_STRING_LENGTH && /\S/u.test(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every(isString);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function freezeStrings(values: readonly string[]): readonly string[] {
	return Object.freeze([...values]);
}

export function validateChildStructuredResult(value: unknown): ChildStructuredResult | undefined {
	if (!isPlainObject(value) || !hasOnly(value, RESULT_KEYS)) return undefined;

	const result: { -readonly [K in keyof ChildStructuredResult]: ChildStructuredResult[K] } = {};

	if ("summary" in value) {
		if (!isString(value.summary)) return undefined;
		result.summary = value.summary;
	}

	for (const key of STRING_LIST_KEYS) {
		if (!(key in value)) continue;
		if (!isStringArray(value[key])) return undefined;
		result[key] = freezeStrings(value[key]);
	}

	if ("validations" in value) {
		if (!Array.isArray(value.validations) || value.validations.length > MAX_LIST_ITEMS) return undefined;
		const validations: Array<Readonly<{ command: string; outcome: string }>> = [];
		for (const item of value.validations) {
			if (
				!isPlainObject(item) ||
				!hasOnly(item, ["command", "outcome"]) ||
				!Object.hasOwn(item, "command") ||
				!Object.hasOwn(item, "outcome") ||
				!isString(item.command) ||
				!isString(item.outcome)
			) {
				return undefined;
			}
			validations.push(Object.freeze({ command: item.command, outcome: item.outcome }));
		}
		result.validations = Object.freeze(validations);
	}

	if ("review" in value) {
		if (
			!isPlainObject(value.review) ||
			!hasOnly(value.review, ["verdict", "findings"]) ||
			!Object.hasOwn(value.review, "verdict") ||
			!Object.hasOwn(value.review, "findings") ||
			!isString(value.review.verdict) ||
			!isStringArray(value.review.findings)
		) {
			return undefined;
		}
		result.review = Object.freeze({
			verdict: value.review.verdict,
			findings: freezeStrings(value.review.findings),
		});
	}

	if ("confidence" in value) {
		if (
			typeof value.confidence !== "number" ||
			!Number.isFinite(value.confidence) ||
			value.confidence < 0 ||
			value.confidence > 1
		) {
			return undefined;
		}
		result.confidence = value.confidence;
	}

	if ("classification" in value) {
		if (!isString(value.classification)) return undefined;
		result.classification = value.classification;
	}

	return Object.freeze(result);
}

export function parseChildStructuredResult(bytes: Buffer): ChildStructuredResult | undefined {
	if (bytes.length === 0) return undefined;
	try {
		return validateChildStructuredResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	} catch {
		return undefined;
	}
}

export function createChildStructuredResultCandidate(): {
	write(chunk: Buffer): void;
	finish(): ChildStructuredResult | undefined;
} {
	let size = 0;
	let overflow = false;
	let chunks: Buffer[] = [];
	return {
		write(chunk) {
			if (overflow) return;
			size += chunk.length;
			if (size > MAX_CHILD_STRUCTURED_RESULT_BYTES) {
				overflow = true;
				chunks = [];
				return;
			}
			chunks.push(chunk);
		},
		finish() {
			return overflow ? undefined : parseChildStructuredResult(Buffer.concat(chunks, size));
		},
	};
}
