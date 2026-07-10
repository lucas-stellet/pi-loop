import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isLoopControlFile } from "./constants.ts";

/** Stable machine-readable policy reasons for `loop.guardrail_violation`. */
export const CONTROL_FILE_POLICY_REASON = {
	disallowedFile: "disallowed_file",
	symlinkDestination: "symlink_destination",
	unsafeDestination: "unsafe_destination",
} as const;

export type ControlFilePolicyReason =
	(typeof CONTROL_FILE_POLICY_REASON)[keyof typeof CONTROL_FILE_POLICY_REASON];

export class ControlFilePolicyError extends Error {
	readonly reason: ControlFilePolicyReason;

	constructor(reason: ControlFilePolicyReason) {
		super("Rejected: file is outside the loop-scoped markdown control artifacts.");
		this.reason = reason;
	}
}

function isPathInside(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function controlDirectory(cwd: string, runId: string): string {
	// Recovered snapshots are not schema-validated; reject path-like run identities.
	if (!runId || isAbsolute(runId) || basename(runId) !== runId || runId.includes("\\")) {
		throw new Error("Loop run identity cannot be used as a control directory.");
	}

	const loopDirectory = resolve(cwd, ".pi", "loop");
	const directory = resolve(loopDirectory, runId);
	if (!isPathInside(loopDirectory, directory)) {
		throw new Error("Loop run identity cannot be used as a control directory.");
	}
	return directory;
}

async function assertRealDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	// lstat does not follow links, so a symlink is never reported as a directory.
	if (!stat.isDirectory()) {
		throw new ControlFilePolicyError(CONTROL_FILE_POLICY_REASON.symlinkDestination);
	}
}

async function ensureControlDirectory(cwd: string, runId: string): Promise<string> {
	const directory = controlDirectory(cwd, runId);
	await mkdir(directory, { recursive: true });

	for (const path of [resolve(cwd, ".pi"), resolve(cwd, ".pi", "loop"), directory]) {
		await assertRealDirectory(path);
	}
	return directory;
}

function isSafeRegularSingleLink(stat: { isFile(): boolean; nlink: number }): boolean {
	return stat.isFile() && stat.nlink === 1;
}

async function assertWritableDestination(destination: string): Promise<void> {
	try {
		const stat = await lstat(destination);
		// Preserve symlink classification before the regular/single-link safety check.
		if (stat.isSymbolicLink()) {
			throw new ControlFilePolicyError(CONTROL_FILE_POLICY_REASON.symlinkDestination);
		}
		if (!isSafeRegularSingleLink(stat)) {
			throw new ControlFilePolicyError(CONTROL_FILE_POLICY_REASON.unsafeDestination);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

export async function seedControlFiles(cwd: string, runId: string, objective: string): Promise<void> {
	await writeControlFile(cwd, runId, "objective.md", objective);
}

export async function writeControlFile(cwd: string, runId: string, file: string, content: string): Promise<void> {
	if (!isLoopControlFile(file)) {
		throw new ControlFilePolicyError(CONTROL_FILE_POLICY_REASON.disallowedFile);
	}

	const directory = await ensureControlDirectory(cwd, runId);
	const destination = join(directory, file);
	await assertWritableDestination(destination);

	let handle: FileHandle | undefined;
	try {
		handle = await open(
			destination,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
		);
		await handle.writeFile(content, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new ControlFilePolicyError(CONTROL_FILE_POLICY_REASON.symlinkDestination);
		}
		throw error;
	} finally {
		await handle?.close();
	}
}
