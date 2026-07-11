import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { realpath, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type DelegateMetadata = Readonly<{
	name: string;
	tools: readonly string[];
	systemPrompt: string;
}>;

export type DelegateRootResolver = () => string | Promise<string>;

export type DelegateResolver = (
	name: string,
	options?: { rootResolver?: DelegateRootResolver },
) => Promise<DelegateMetadata | undefined>;

/** Exact approved caller names → fixed filenames under the user agent directory. */
const APPROVED_AGENTS = new Map([["delegate", "delegate.md"]]);

/** True when `candidate` is strictly inside `root` after both paths are already resolved. */
function isInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath !== "" &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	);
}

function parseTools(frontmatter: Record<string, unknown>): string[] | undefined {
	const raw = frontmatter.tools;
	if (typeof raw === "string") {
		const tools = raw.split(",").map((tool) => tool.trim());
		return tools.length > 0 && tools.every(Boolean) ? tools : undefined;
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		return undefined;
	}
	const tools: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			return undefined;
		}
		const tool = entry.trim();
		if (!tool) {
			return undefined;
		}
		tools.push(tool);
	}
	return tools;
}

function immutableMetadata(name: string, tools: string[], systemPrompt: string): DelegateMetadata {
	return Object.freeze({
		name,
		tools: Object.freeze([...tools]),
		systemPrompt,
	});
}

/** Resolve only the fixed, user-scoped agent definitions trusted by pi-loop. */
export async function resolveDelegate(
	name: string,
	options: { rootResolver?: DelegateRootResolver } = {},
): Promise<DelegateMetadata | undefined> {
	const filename = APPROVED_AGENTS.get(name);
	if (!filename) {
		return undefined;
	}

	try {
		const resolveRoot = options.rootResolver ?? getAgentDir;
		const userAgentRoot = await realpath(await resolveRoot());
		const agentsDirectory = await realpath(join(userAgentRoot, "agents"));
		if (!isInside(userAgentRoot, agentsDirectory)) {
			return undefined;
		}
		const file = await realpath(join(agentsDirectory, filename));
		if (!isInside(agentsDirectory, file)) {
			return undefined;
		}

		const { frontmatter, body } = parseFrontmatter(await readFile(file, "utf8"));
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
			return undefined;
		}
		const tools = parseTools(frontmatter);
		if (frontmatter.name !== name || !body.trim() || !tools) {
			return undefined;
		}
		return immutableMetadata(name, tools, body);
	} catch {
		return undefined;
	}
}
