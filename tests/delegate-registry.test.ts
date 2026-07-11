import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveDelegate } from "../src/delegate-registry.ts";

const validDefinition = (tools: string | string[] = "read, bash") =>
	`---\nname: delegate\ntools: ${Array.isArray(tools) ? `\n${tools.map((tool) => `  - ${tool}`).join("\n")}` : tools}\n---\nTrusted prompt`;

const REJECTED_DELEGATE_NAMES = [
	"",
	"Delegate",
	" delegate",
	"delegate ",
	"delegate.md",
	"agents/delegate",
	"../delegate",
	"../../delegate",
	"delegate/other",
	"\\delegate",
	"/delegate",
];

async function withUserAgentRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-delegate-registry-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		await run(root);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

async function writeDelegate(root: string, contents = validDefinition()): Promise<void> {
	await mkdir(join(root, "agents"), { recursive: true });
	await writeFile(join(root, "agents", "delegate.md"), contents);
}

test("resolveDelegate accepts only a valid fixed user-scope delegate definition", async () => {
	await withUserAgentRoot(async (root) => {
		await writeDelegate(root);
		assert.deepEqual(await resolveDelegate("delegate"), {
			name: "delegate",
			tools: ["read", "bash"],
			systemPrompt: "Trusted prompt",
		});

		for (const name of REJECTED_DELEGATE_NAMES) {
			assert.equal(await resolveDelegate(name), undefined, name);
		}
	});
});

test("resolveDelegate rejects unapproved keys before consulting its configured root resolver", async () => {
	let rootLookups = 0;
	const rootResolver = async () => {
		rootLookups += 1;
		return "/a-controlled-root";
	};
	for (const name of REJECTED_DELEGATE_NAMES) {
		assert.equal(await resolveDelegate(name, { rootResolver }), undefined, name);
		assert.equal(rootLookups, 0, `root resolver must not run for ${JSON.stringify(name)}`);
	}
});

test("resolveDelegate never falls back to a project definition when the user definition is absent", async () => {
	await withUserAgentRoot(async (root) => {
		const project = join(root, "project", ".pi", "agents");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "delegate.md"), validDefinition());
		assert.equal(await resolveDelegate("delegate"), undefined);
	});
});

test("resolveDelegate rejects missing and non-regular trusted definitions", async () => {
	await withUserAgentRoot(async (root) => {
		assert.equal(await resolveDelegate("delegate"), undefined, "missing agents directory");
		await mkdir(join(root, "agents"));
		assert.equal(await resolveDelegate("delegate"), undefined, "missing fixed file");
		await mkdir(join(root, "agents", "delegate.md"));
		assert.equal(await resolveDelegate("delegate"), undefined, "directory is not a definition");
	});
});

test("resolveDelegate rejects malformed delegate metadata", async () => {
	await withUserAgentRoot(async (root) => {
		const invalid = [
			"---\ntools: read\n---\nprompt",
			"---\nname: other\ntools: read\n---\nprompt",
			"---\nname: 1\ntools: read\n---\nprompt",
			"---\nname: delegate\ntools: read\n---\n   ",
			"---\nname: delegate\n---\nprompt",
			"---\nname: delegate\ntools: \n---\nprompt",
			"---\nname: delegate\ntools: '   '\n---\nprompt",
			"---\nname: delegate\ntools: []\n---\nprompt",
			"---\nname: delegate\ntools: read, , bash\n---\nprompt",
			"---\nname: delegate\ntools: read,   \n---\nprompt",
			"---\nname: delegate\ntools:\n  - read\n  - ''\n---\nprompt",
			"---\nname: delegate\ntools:\n  - read\n  - '   '\n---\nprompt",
			"---\nname: delegate\ntools:\n  - read\n  - 1\n---\nprompt",
			"---\nname: delegate\ntools: [read\n---\nprompt",
			"---\n- delegate\n---\nprompt",
		];
		for (const definition of invalid) {
			await writeDelegate(root, definition);
			assert.equal(await resolveDelegate("delegate"), undefined, definition);
		}
		await writeDelegate(root, validDefinition(["read", "bash"]));
		assert.deepEqual((await resolveDelegate("delegate"))?.tools, ["read", "bash"]);
	});
});

test("resolveDelegate rejects symlink escapes but permits contained files", async () => {
	const outside = await mkdtemp(join(tmpdir(), "pi-loop-delegate-outside-"));
	try {
		await withUserAgentRoot(async (root) => {
			await writeFile(join(outside, "delegate.md"), validDefinition());
			await mkdir(join(root, "agents"));
			await symlink(join(outside, "delegate.md"), join(root, "agents", "delegate.md"));
			assert.equal(await resolveDelegate("delegate"), undefined, "file symlink escape");
			await rm(join(root, "agents"), { recursive: true });
			await symlink(outside, join(root, "agents"));
			assert.equal(await resolveDelegate("delegate"), undefined, "agents directory symlink escape");
			await rm(join(root, "agents"));
			await writeDelegate(root);
			assert.ok(await resolveDelegate("delegate"));
		});
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("resolveDelegate returns a detached immutable metadata snapshot", async () => {
	await withUserAgentRoot(async (root) => {
		await writeDelegate(root);
		const metadata = await resolveDelegate("delegate");
		assert.ok(metadata);
		assert.equal(Object.isFrozen(metadata), true);
		assert.equal(Object.isFrozen(metadata.tools), true);
		assert.throws(() => (metadata.tools as string[]).push("write"));
		assert.throws(() => Object.assign(metadata, { name: "other" }));
		await writeDelegate(root, validDefinition("write"));
		assert.deepEqual(metadata, { name: "delegate", tools: ["read", "bash"], systemPrompt: "Trusted prompt" });
	});
});
