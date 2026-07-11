import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isPathInside, loopRunDirectory } from "./loop-paths.ts";

const ARTIFACT_FILENAMES = {
	stdout: "stdout.bin",
	stderr: "stderr.bin",
	final: "final.bin",
	structured: "structured.bin",
} as const;

type ArtifactKind = keyof typeof ARTIFACT_FILENAMES;

export type ChildArtifactStore = {
	writeStdout(content: Buffer): Promise<void>;
	writeStderr(content: Buffer): Promise<void>;
	finalize(output?: { final?: Buffer; structured?: Buffer }): Promise<string[]>;
};

function assertOpaqueId(id: string): void {
	if (
		typeof id !== "string" ||
		!id ||
		Buffer.byteLength(id, "utf8") > 255 ||
		id === "." ||
		id === ".." ||
		id.includes("/") ||
		id.includes("\\") ||
		/[\x00-\x1f\x7f]/.test(id)
	) {
		throw new Error("Child artifact identity cannot be used as a directory.");
	}
}

function artifactFilename(kind: ArtifactKind): string {
	return ARTIFACT_FILENAMES[kind];
}

/** Parent-run-relative ref; always uses fixed runtime filenames and `/` separators. */
function artifactRef(childRunId: string, kind: ArtifactKind): string {
	return `children/${childRunId}/${artifactFilename(kind)}`;
}

function artifactPath(directory: string, kind: ArtifactKind): string {
	return join(directory, artifactFilename(kind));
}

async function assertRealDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	// lstat does not follow links, so a symlink is never reported as a directory.
	if (!stat.isDirectory()) {
		throw new Error("Child artifact directory is unsafe.");
	}
}

/** Create `path` when absent, then require a real directory (never a symlink). */
async function ensureRealDirectory(path: string): Promise<void> {
	try {
		await mkdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await assertRealDirectory(path);
}

async function ensureDirectory(cwd: string, parentRunId: string, childRunId: string): Promise<string> {
	// Lexical containment first: never mkdir from an unchecked path segment.
	const parentDirectory = loopRunDirectory(cwd, parentRunId);
	const childrenRoot = join(parentDirectory, "children");
	const directory = resolve(childrenRoot, childRunId);
	if (!isPathInside(childrenRoot, directory)) {
		throw new Error("Child artifact identity cannot be used as a directory.");
	}

	// One managed component at a time: non-recursive mkdir, then lstat before descending.
	// Rejects symlink ancestors before outside descendants can be created through them.
	// Path-based checks still leave an unavoidable TOCTOU window; Node does not expose
	// a portable openat/directory-fd walk, so this does not claim race-free containment.
	let current = cwd;
	for (const segment of [".pi", "loop", parentRunId, "children", childRunId]) {
		current = resolve(current, segment);
		await ensureRealDirectory(current);
	}
	return current;
}

function assertSafeFile(stat: { isFile(): boolean; nlink: number }): void {
	if (!stat.isFile() || stat.nlink !== 1) {
		throw new Error("Child artifact destination is unsafe.");
	}
}

async function writeArtifact(path: string, content: Buffer, flags: number): Promise<void> {
	const handle = await open(path, flags | fsConstants.O_NOFOLLOW, 0o600);
	try {
		assertSafeFile(await handle.stat());
		await handle.writeFile(content);
	} finally {
		await handle.close();
	}
}

async function appendArtifact(path: string, content: Buffer): Promise<void> {
	await writeArtifact(path, content, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);
}

async function replaceArtifact(path: string, content: Buffer): Promise<void> {
	await writeArtifact(path, content, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC);
}

/** Accept only omitted input or a plain object; require every present final/structured value to be a Buffer. */
function readFinalizeBuffers(output: unknown): { final?: Buffer; structured?: Buffer } {
	if (typeof output !== "object" || output === null || Array.isArray(output)) {
		throw new Error("Child artifact finalization output must be a plain object.");
	}
	const prototype = Object.getPrototypeOf(output);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error("Child artifact finalization output must be a plain object.");
	}

	const result: { final?: Buffer; structured?: Buffer } = {};
	if (Object.hasOwn(output, "final")) {
		const final = (output as { final: unknown }).final;
		if (!Buffer.isBuffer(final)) {
			throw new Error("Child artifact finalization values must be Buffers.");
		}
		result.final = final;
	}
	if (Object.hasOwn(output, "structured")) {
		const structured = (output as { structured: unknown }).structured;
		if (!Buffer.isBuffer(structured)) {
			throw new Error("Child artifact finalization values must be Buffers.");
		}
		result.structured = structured;
	}
	return result;
}

/** Re-open with O_NOFOLLOW so exposed refs always resolve to a regular single-link file. */
async function assertSafeArtifact(path: string): Promise<void> {
	const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		assertSafeFile(await handle.stat());
	} finally {
		await handle.close();
	}
}

export async function createChildArtifactStore({
	cwd,
	parentRunId,
	childRunId,
}: {
	cwd: string;
	parentRunId: string;
	childRunId: string;
}): Promise<ChildArtifactStore> {
	assertOpaqueId(parentRunId);
	assertOpaqueId(childRunId);
	const directory = await ensureDirectory(cwd, parentRunId, childRunId);
	let finalized = false;
	let operations = Promise.resolve();

	const assertWritable = (): void => {
		if (finalized) throw new Error("Child artifacts are already finalized.");
	};

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = operations.then(operation);
		operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const writeStream = async (kind: "stdout" | "stderr", content: Buffer): Promise<void> => {
		if (!Buffer.isBuffer(content)) throw new Error("Child artifact content must be a Buffer.");
		return enqueue(async () => {
			assertWritable();
			await appendArtifact(artifactPath(directory, kind), content);
		});
	};

	// Always-present stream artifacts exist as empty regular files once the store is created.
	await appendArtifact(artifactPath(directory, "stdout"), Buffer.alloc(0));
	await appendArtifact(artifactPath(directory, "stderr"), Buffer.alloc(0));

	return {
		writeStdout: (content) => writeStream("stdout", content),
		writeStderr: (content) => writeStream("stderr", content),
		finalize: async (output = {}) => {
			// Validate the whole container and present fields before any optional write is queued.
			const optional = readFinalizeBuffers(output);

			return enqueue(async () => {
				assertWritable();
				const kinds: ArtifactKind[] = ["stdout", "stderr"];
				if (optional.final !== undefined) {
					await replaceArtifact(artifactPath(directory, "final"), optional.final);
					kinds.push("final");
				}
				if (optional.structured !== undefined) {
					await replaceArtifact(artifactPath(directory, "structured"), optional.structured);
					kinds.push("structured");
				}

				const refs: string[] = [];
				for (const kind of kinds) {
					await assertSafeArtifact(artifactPath(directory, kind));
					refs.push(artifactRef(childRunId, kind));
				}
				finalized = true;
				return refs;
			});
		},
	};
}
