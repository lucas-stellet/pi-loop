import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** True when `child` resolves strictly inside `parent` (not equal, not outside). */
export function isPathInside(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

/**
 * Resolve the runtime-managed directory `.pi/loop/<runId>` under `cwd`.
 * Rejects empty, absolute, or path-like run identities so callers cannot escape the loop root.
 */
export function loopRunDirectory(cwd: string, runId: string): string {
	// Recovered snapshots are not schema-validated; reject path-like run identities.
	if (!runId || isAbsolute(runId) || basename(runId) !== runId || runId.includes("\\")) {
		throw new Error("Loop run identity cannot be used as a run directory.");
	}

	const loopRoot = resolve(cwd, ".pi", "loop");
	const directory = resolve(loopRoot, runId);
	if (!isPathInside(loopRoot, directory)) {
		throw new Error("Loop run identity cannot be used as a run directory.");
	}
	return directory;
}
