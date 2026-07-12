import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { createChildArtifactStore } from "../../src/child-artifacts.ts";

const [cwd, kind, operation] = process.argv.slice(2);
if (!cwd || !kind || !operation) throw new Error("Expected cwd, kind, and operation.");

const parentRunId = "parent-opaque-id";
const childRunId = `${kind}-${operation}`;
const path = join(cwd, ".pi", "loop", parentRunId, "children", childRunId, `${kind}.bin`);
const store = await createChildArtifactStore({ cwd, parentRunId, childRunId });
await rm(path, { force: true });
execFileSync("/usr/bin/mkfifo", [path]);

try {
	if (operation === "write") {
		if (kind === "stdout") await store.writeStdout(Buffer.from("write"));
		else if (kind === "stderr") await store.writeStderr(Buffer.from("write"));
		else throw new Error("Only streams can be written.");
	} else if (operation === "finalize") {
		await store.finalize(kind === "final" ? { final: Buffer.from("final") } : kind === "structured" ? { structured: Buffer.from("structured") } : undefined);
	} else if (operation === "ref") {
		await store.finalize();
	} else throw new Error("Unknown operation.");
	console.log("SUCCESS");
} catch {
	console.log("REJECTED");
}
