import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

type RegisteredTool = {
	name: string;
	parameters: { required?: readonly string[]; properties?: Record<string, { type?: string }> };
	execute: (toolCallId: string, params: unknown) => Promise<unknown>;
};

const extensionUrl = new URL("../src/child-result-extension.ts", import.meta.url).href;

async function registeredTool(): Promise<RegisteredTool> {
	const module = await import(extensionUrl) as {
		default: (pi: { registerTool(tool: RegisteredTool): void }) => void;
	};
	const tools: RegisteredTool[] = [];
	module.default({ registerTool: (tool) => tools.push(tool) });
	assert.equal(tools.length, 1);
	return tools[0]!;
}

test("package-owned extension registers only loop_result with one required opaque result record", async () => {
	const tool = await registeredTool();
	assert.equal(tool.name, "loop_result");
	assert.deepEqual(tool.parameters.required, ["result"]);
	assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), ["result"]);
	assert.equal(tool.parameters.properties?.result?.type, "object");
});

test("loop_result writes exact unicode JSON to fd 3, terminates without payload leakage, and claims failed attempts", () => {
	const result = { sentinel: "FD3_ONLY_SENTINEL", nested: { unicode: "雪😀" } };
	const script = `
		import factory from ${JSON.stringify(extensionUrl)};
		const tools = [];
		factory({ registerTool: (tool) => tools.push(tool) });
		const acknowledgement = await tools[0].execute("first", { result: ${JSON.stringify(result)} });
		try { await tools[0].execute("duplicate", { result: { second: true } }); process.exitCode = 2; } catch {}
		process.stdout.write(JSON.stringify(acknowledgement));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
	assert.equal(child.status, 0, child.stderr.toString("utf8"));
	assert.deepEqual(child.output[3], Buffer.from(JSON.stringify(result), "utf8"));
	const acknowledgementText = child.stdout.toString("utf8");
	assert.equal(JSON.parse(acknowledgementText).terminate, true);
	assert.equal(acknowledgementText.includes(result.sentinel), false);
});

test("loop_result rejects missing and unserializable results, and an unavailable fd claims the attempt before retry", async () => {
	const circular: { self?: unknown } = {};
	circular.self = circular;
	for (const params of [{}, { result: undefined }, { result: BigInt(1) }, { result: circular }]) {
		const tool = await registeredTool();
		await assert.rejects(tool.execute("invalid", params));
	}
	const unavailable = await registeredTool();
	await assert.rejects(unavailable.execute("unavailable-fd", { result: { sentinel: "MUST_NOT_APPEND" } }));
	await assert.rejects(unavailable.execute("retry", { result: { second: true } }));
});

test("loop_result rejects top-level stringify-to-undefined after claiming its only attempt", () => {
	const script = `
		import factory from ${JSON.stringify(extensionUrl)};
		const tools = [];
		factory({ registerTool: (tool) => tools.push(tool) });
		const result = { toJSON() { return undefined; } };
		try { await tools[0].execute("first", { result }); process.exitCode = 2; } catch {}
		try { await tools[0].execute("retry", { result: {} }); process.exitCode = 3; } catch {}
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
	assert.equal(child.status, 0, child.stderr.toString("utf8"));
	assert.deepEqual(child.output[3], Buffer.alloc(0));
});

test("internal full-write helper advances partial writes and rejects invalid write progress", async () => {
	const module = await import(extensionUrl) as {
		writeAllToFd?: (fd: number, bytes: Buffer, write: (fd: number, bytes: Buffer, offset: number, length: number) => number) => void;
	};
	assert.equal(typeof module.writeAllToFd, "function");
	const calls: number[] = [];
	module.writeAllToFd!(3, Buffer.from("abcdef"), (_fd, _bytes, offset, length) => {
		calls.push(offset);
		return Math.min(2, length);
	});
	assert.deepEqual(calls, [0, 2, 4]);
	for (const progress of [0, -1, 1.5, 99]) {
		assert.throws(() => module.writeAllToFd!(3, Buffer.from("x"), () => progress));
	}
	const origin = new Error("injected writer failure");
	assert.throws(() => module.writeAllToFd!(3, Buffer.from("x"), () => { throw origin; }), (error: unknown) => error === origin);
});
