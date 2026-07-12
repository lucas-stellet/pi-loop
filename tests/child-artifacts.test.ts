import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createChildArtifactStore } from "../src/child-artifacts.ts";

async function withCwd(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-"));
	try {
		await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function artifactPath(cwd: string, parentRunId: string, childRunId: string, filename: string): string {
	return join(cwd, ".pi", "loop", parentRunId, "children", childRunId, filename);
}

const managedSegments = [".pi", "loop", "parent-opaque-id", "children", "child-opaque-id"];

function managedPath(cwd: string, position: number): string {
	return join(cwd, ...managedSegments.slice(0, position + 1));
}

async function createRealAncestors(cwd: string, position: number): Promise<void> {
	if (position > 0) await mkdir(managedPath(cwd, position - 1), { recursive: true });
}

const fifoProbe = fileURLToPath(new URL("./fixtures/child-artifact-fifo-probe.ts", import.meta.url));

async function runFifoProbe(cwd: string, kind: string, operation: "write" | "finalize" | "ref"): Promise<string> {
	const child = spawn(process.execPath, [fifoProbe, cwd, kind, operation], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (signal === "SIGKILL") {
				reject(new Error(`FIFO probe timed out for ${kind} ${operation}.`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`FIFO probe exited ${code} for ${kind} ${operation}.`));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

type TreeEntry = { type: "directory" } | { type: "file"; bytes: Buffer } | { type: "symlink" } | { type: "other" };

async function snapshotTree(root: string): Promise<Record<string, TreeEntry>> {
	const entries: Record<string, TreeEntry> = {};
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const key = relative(root, path);
			if (entry.isDirectory()) {
				entries[key] = { type: "directory" };
				await visit(path);
			} else if (entry.isFile()) entries[key] = { type: "file", bytes: await readFile(path) };
			else if (entry.isSymbolicLink()) entries[key] = { type: "symlink" };
			else entries[key] = { type: "other" };
		}
	};
	await visit(root);
	return entries;
}

test("child artifact store validates opaque IDs before creating managed paths", async () => {
	const invalidIds: unknown[] = [
		"",
		".",
		"..",
		"parent/child",
		"parent\\child",
		"prefix\u0001suffix",
		"prefix\u007fsuffix",
		"😀".repeat(64), // 128 UTF-16 code units but 256 UTF-8 bytes.
		42,
		null,
	];

	for (const position of ["parentRunId", "childRunId"] as const) {
		for (const invalidId of invalidIds) {
			await withCwd(async (cwd) => {
				const ids = { parentRunId: "parent-opaque-id", childRunId: "child-opaque-id" };
				ids[position] = invalidId as string;
				await assert.rejects(createChildArtifactStore({ cwd, ...ids }));
				assert.deepEqual(await readdir(cwd), []);
			});
		}
	}

	await withCwd(async (cwd) => {
		const parentRunId = `${"😀".repeat(63)}abc`; // 255 UTF-8 bytes.
		const store = await createChildArtifactStore({ cwd, parentRunId, childRunId: "child-opaque-id" });
		await store.finalize();
	});
});

test("child artifact store rejects a symlinked managed ancestor before creating outside descendants", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-outside-"));
	try {
		await symlink(outside, join(cwd, ".pi"));

		await assert.rejects(
			createChildArtifactStore({
				cwd,
				parentRunId: "parent-opaque-id",
				childRunId: "child-opaque-id",
			}),
		);
		assert.deepEqual(await readdir(outside), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("child artifact store rejects symlinked managed components without mutating their targets", async () => {
	for (const targetType of ["outside", "inside", "dangling"] as const) {
		for (const [position, segment] of managedSegments.entries()) {
			const cwd = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-"));
			const outside = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-outside-"));
			try {
				await createRealAncestors(cwd, position);
				const target = targetType === "outside" ? outside : join(cwd, `${targetType}-target-${position}`);
				if (targetType === "inside") await mkdir(target);
				if (targetType === "outside" && position === managedSegments.length - 1) {
					await writeFile(join(target, "stdout.bin"), "outside stdout sentinel");
					await writeFile(join(target, "stderr.bin"), "outside stderr sentinel");
				}
				const before = targetType === "dangling" ? undefined : await snapshotTree(target);
				await symlink(target, managedPath(cwd, position));

				await assert.rejects(
					createChildArtifactStore({ cwd, parentRunId: managedSegments[2], childRunId: managedSegments[4] }),
					`${targetType} symlink at ${segment} must be rejected`,
				);
				if (targetType === "dangling") await assert.rejects(readdir(target));
				else assert.deepEqual(await snapshotTree(target), before);
				if (targetType === "outside" && position === managedSegments.length - 1) {
					assert.deepEqual(await readFile(join(target, "stdout.bin")), Buffer.from("outside stdout sentinel"));
					assert.deepEqual(await readFile(join(target, "stderr.bin")), Buffer.from("outside stderr sentinel"));
				}
			} finally {
				await rm(cwd, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		}
	}
});

test("child artifact store rejects shallow and deep regular-file managed components", async () => {
	for (const position of [0, 3]) {
		const cwd = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-loop-child-artifacts-outside-"));
		try {
			await createRealAncestors(cwd, position);
			await writeFile(managedPath(cwd, position), "not a directory");
			const before = await snapshotTree(outside);

			await assert.rejects(
				createChildArtifactStore({ cwd, parentRunId: managedSegments[2], childRunId: managedSegments[4] }),
			);
			assert.equal(await readFile(managedPath(cwd, position), "utf8"), "not a directory");
			assert.deepEqual(await snapshotTree(outside), before);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}
});

test("child artifact store supports a fully pre-created real managed directory tree", async () => {
	await withCwd(async (cwd) => {
		const parentRunId = managedSegments[2];
		const childRunId = managedSegments[4];
		await mkdir(managedPath(cwd, managedSegments.length - 1), { recursive: true });

		const store = await createChildArtifactStore({ cwd, parentRunId, childRunId });
		await store.writeStdout(Buffer.from("stdout"));
		await store.writeStderr(Buffer.from("stderr"));
		assert.deepEqual(await store.finalize({ final: Buffer.from("final"), structured: Buffer.from("structured") }), [
			"children/child-opaque-id/stdout.bin",
			"children/child-opaque-id/stderr.bin",
			"children/child-opaque-id/final.bin",
			"children/child-opaque-id/structured.bin",
		]);
		assert.deepEqual(await Promise.all(["stdout.bin", "stderr.bin", "final.bin", "structured.bin"].map((filename) => readFile(artifactPath(cwd, parentRunId, childRunId, filename), "utf8"))), [
			"stdout",
			"stderr",
			"final",
			"structured",
		]);
	});
});

test("child artifact store appends only Buffer stream bytes in invocation order", async () => {
	await withCwd(async (cwd) => {
		const parentRunId = "parent-opaque-id";
		const childRunId = "child-opaque-id";
		const store = await createChildArtifactStore({ cwd, parentRunId, childRunId });
		const stdout = artifactPath(cwd, parentRunId, childRunId, "stdout.bin");
		const stderr = artifactPath(cwd, parentRunId, childRunId, "stderr.bin");

		const firstStdout = store.writeStdout(Buffer.from([0xff, 0x00]));
		const secondStdout = store.writeStdout(Buffer.from([0x80, 0x01]));
		const firstStderr = store.writeStderr(Buffer.from([0xfe]));
		const secondStderr = store.writeStderr(Buffer.from([0x02]));
		await Promise.all([firstStdout, secondStdout, firstStderr, secondStderr]);
		assert.deepEqual(await readFile(stdout), Buffer.from([0xff, 0x00, 0x80, 0x01]));
		assert.deepEqual(await readFile(stderr), Buffer.from([0xfe, 0x02]));

		for (const invalidContent of ["coerced", new Uint8Array([3]), null]) {
			await assert.rejects(store.writeStdout(invalidContent as unknown as Buffer));
			await assert.rejects(store.writeStderr(invalidContent as unknown as Buffer));
		}
		assert.deepEqual(await readFile(stdout), Buffer.from([0xff, 0x00, 0x80, 0x01]));
		assert.deepEqual(await readFile(stderr), Buffer.from([0xfe, 0x02]));
	});
});

test("child artifact store validates finalize inputs atomically and returns deterministic refs", async () => {
	await withCwd(async (cwd) => {
		const parentRunId = "parent-opaque-id";
		const childRunId = "child-opaque-id";
		const omitted = await createChildArtifactStore({ cwd, parentRunId, childRunId: "omitted" });
		assert.deepEqual(await omitted.finalize(), [
			"children/omitted/stdout.bin",
			"children/omitted/stderr.bin",
		]);
		assert.deepEqual(await readFile(artifactPath(cwd, parentRunId, "omitted", "stdout.bin")), Buffer.alloc(0));
		assert.deepEqual(await readFile(artifactPath(cwd, parentRunId, "omitted", "stderr.bin")), Buffer.alloc(0));

		const finalOnly = await createChildArtifactStore({ cwd, parentRunId, childRunId: "final-only" });
		assert.deepEqual(await finalOnly.finalize({ final: Buffer.from([0xff]) }), [
			"children/final-only/stdout.bin",
			"children/final-only/stderr.bin",
			"children/final-only/final.bin",
		]);

		const structuredOnly = await createChildArtifactStore({ cwd, parentRunId, childRunId: "structured-only" });
		assert.deepEqual(await structuredOnly.finalize({ structured: Buffer.from([0xfe]) }), [
			"children/structured-only/stdout.bin",
			"children/structured-only/stderr.bin",
			"children/structured-only/structured.bin",
		]);

		const both = await createChildArtifactStore({ cwd, parentRunId, childRunId });
		assert.deepEqual(await both.finalize({ final: Buffer.from([0xff]), structured: Buffer.from([0xfe]) }), [
			"children/child-opaque-id/stdout.bin",
			"children/child-opaque-id/stderr.bin",
			"children/child-opaque-id/final.bin",
			"children/child-opaque-id/structured.bin",
		]);

		for (const [index, invalidOutput] of [null, [], "bad", new Date(), { final: undefined }, { structured: undefined }, { final: new Uint8Array([1]) }].entries()) {
			const store = await createChildArtifactStore({ cwd, parentRunId, childRunId: `invalid-${index}` });
			await assert.rejects(store.finalize(invalidOutput as never));
		}

		const atomic = await createChildArtifactStore({ cwd, parentRunId, childRunId: "atomic" });
		await assert.rejects(atomic.finalize({ final: Buffer.from("must-not-write"), structured: "coerced" as unknown as Buffer }));
		await assert.rejects(readFile(artifactPath(cwd, parentRunId, "atomic", "final.bin")));
	});
});

test("child artifact store rejects unsafe writable destinations without changing outside targets", async () => {
	const artifacts = [
		{ kind: "stdout", operation: (store: Awaited<ReturnType<typeof createChildArtifactStore>>) => store.writeStdout(Buffer.from("stdout")) },
		{ kind: "stderr", operation: (store: Awaited<ReturnType<typeof createChildArtifactStore>>) => store.writeStderr(Buffer.from("stderr")) },
		{ kind: "final", operation: (store: Awaited<ReturnType<typeof createChildArtifactStore>>) => store.finalize({ final: Buffer.from("final") }) },
		{ kind: "structured", operation: (store: Awaited<ReturnType<typeof createChildArtifactStore>>) => store.finalize({ structured: Buffer.from("structured") }) },
	] as const;

	for (const artifact of artifacts) {
		for (const unsafe of ["symlink", "hardlink", "directory"] as const) {
			await withCwd(async (cwd) => {
				const parentRunId = "parent-opaque-id";
				const childRunId = `${artifact.kind}-${unsafe}`;
				const store = await createChildArtifactStore({ cwd, parentRunId, childRunId });
				const path = artifactPath(cwd, parentRunId, childRunId, `${artifact.kind}.bin`);
				const sentinel = join(cwd, `${artifact.kind}-${unsafe}-sentinel`);
				await rm(path, { recursive: true, force: true });
				if (unsafe === "directory") await mkdir(path);
				else {
					const bytes = Buffer.from(`${artifact.kind}-${unsafe}-sentinel`);
					await writeFile(sentinel, bytes);
					if (unsafe === "symlink") await symlink(sentinel, path);
					else await link(sentinel, path);
					await assert.rejects(artifact.operation(store));
					assert.deepEqual(await readFile(sentinel), bytes);
					return;
				}
				await assert.rejects(artifact.operation(store));
				assert.equal((await lstat(path)).isDirectory(), true);
			});
		}
	}
});

test("child artifact store rejects unsafe stream paths before exposing final refs", async () => {
	for (const unsafe of ["symlink", "hardlink", "directory"] as const) {
		await withCwd(async (cwd) => {
			const parentRunId = "parent-opaque-id";
			const childRunId = `ref-${unsafe}`;
			const store = await createChildArtifactStore({ cwd, parentRunId, childRunId });
			const path = artifactPath(cwd, parentRunId, childRunId, "stdout.bin");
			const sentinel = join(cwd, `ref-${unsafe}-sentinel`);
			await rm(path, { recursive: true, force: true });
			if (unsafe === "directory") {
				await mkdir(path);
			} else {
				const bytes = Buffer.from(`ref-${unsafe}-sentinel`);
				await writeFile(sentinel, bytes);
				if (unsafe === "symlink") await symlink(sentinel, path);
				else await link(sentinel, path);
				await assert.rejects(store.finalize());
				assert.deepEqual(await readFile(sentinel), bytes);
				return;
			}
			await assert.rejects(store.finalize());
			assert.equal((await lstat(path)).isDirectory(), true);
		});
	}
});

test("child artifact store FIFO operations reject in bounded subprocesses", async () => {
	await withCwd(async (cwd) => {
		for (const [kind, operation] of [
			["stdout", "write"],
			["stderr", "write"],
			["final", "finalize"],
			["structured", "finalize"],
			["stdout", "ref"],
		] as const) {
			assert.equal(await runFifoProbe(cwd, kind, operation), "REJECTED");
		}
	});
});

test("child artifact store replaces optional bytes on recreation and locks after successful finalize", async () => {
	await withCwd(async (cwd) => {
		const parentRunId = "parent-opaque-id";
		const childRunId = "child-opaque-id";
		const first = await createChildArtifactStore({ cwd, parentRunId, childRunId });
		await first.finalize({ final: Buffer.from("long-final"), structured: Buffer.from("long-structured") });

		const store = await createChildArtifactStore({ cwd, parentRunId, childRunId });
		await store.writeStdout(Buffer.from([0xff]));
		const refs = await store.finalize({ final: Buffer.from("x"), structured: Buffer.from("y") });
		const paths = refs.map((ref) => join(cwd, ".pi", "loop", parentRunId, ref));
		assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), [
			Buffer.from([0xff]),
			Buffer.alloc(0),
			Buffer.from("x"),
			Buffer.from("y"),
		]);

		const before = await Promise.all(paths.map((path) => readFile(path)));
		await assert.rejects(store.writeStdout(Buffer.from("later")));
		await assert.rejects(store.writeStderr(Buffer.from("later")));
		await assert.rejects(store.finalize());
		assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
		assert.deepEqual(refs, [
			"children/child-opaque-id/stdout.bin",
			"children/child-opaque-id/stderr.bin",
			"children/child-opaque-id/final.bin",
			"children/child-opaque-id/structured.bin",
		]);
	});
});
