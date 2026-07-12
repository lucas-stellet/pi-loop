import assert from "node:assert/strict";
import test from "node:test";

import { PiJsonFinalCapture } from "../src/pi-json-final-capture.ts";

const MAX_EVENT_LINE_BYTES = 64 * 1024;

function messageEnd(textBlocks: string[], options: { role?: string; ending?: string } = {}): Buffer {
	return Buffer.from(JSON.stringify({
		type: "message_end",
		message: {
			role: options.role ?? "assistant",
			content: textBlocks.map((text) => ({ type: "text", text })),
		},
	}) + (options.ending ?? "\n"), "utf8");
}

function capture(...chunks: Buffer[]): Buffer | undefined {
	const result = new PiJsonFinalCapture();
	for (const chunk of chunks) result.write(chunk);
	return result.finish();
}

test("frames documented message_end JSON across every chunk boundary", () => {
	const line = messageEnd(["héllo", " 世界"]);
	for (let split = 0; split <= line.length; split += 1) {
		assert.deepEqual(capture(line.subarray(0, split), line.subarray(split)), Buffer.from("héllo 世界"));
	}

	const multiple = Buffer.concat([
		messageEnd(["older"], { ending: "\r\n" }),
		messageEnd(["latest"], { ending: "" }),
	]);
	assert.deepEqual(capture(multiple), Buffer.from("latest"));
});

test("selects the latest assistant text while preserving explicit empty and tool-only fallback semantics", () => {
	const latest = new PiJsonFinalCapture();
	latest.write(messageEnd(["first"]));
	latest.write(Buffer.from(`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
	})}\n`));
	assert.deepEqual(latest.finish(), Buffer.from("first"));

	const empty = new PiJsonFinalCapture();
	empty.write(messageEnd(["non-empty"]));
	empty.write(messageEnd([""]));
	assert.deepEqual(empty.finish(), Buffer.alloc(0));

	const mixed = new PiJsonFinalCapture();
	mixed.write(Buffer.from(`${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }, { type: "text", text: 7 }],
		},
	})}\n`));
	assert.deepEqual(mixed.finish(), Buffer.from("ab"));
});

test("ignores malformed binary and undocumented lines without poisoning later valid output", () => {
	const ignored = [
		Buffer.from("raw prose that resembles {\"summary\":\"authority\"}\n"),
		Buffer.from("{malformed json}\n"),
		Buffer.from("[]\n"),
		Buffer.from("null\n"),
		Buffer.from(`${JSON.stringify({ type: "agent_end", message: { role: "assistant", content: [{ type: "text", text: "agent end" }] } })}\n`),
		messageEnd(["user text"], { role: "user" }),
		Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "not-an-array" } })}\n`),
		Buffer.from([0xff, 0xfe, 0x0a]),
	];
	const valid = messageEnd(['{"summary":"prose only","files":["fake.ts"],"blocker":"fake"}']);
	assert.deepEqual(capture(...ignored, valid), Buffer.from('{"summary":"prose only","files":["fake.ts"],"blocker":"fake"}'));
	assert.equal(capture(...ignored), undefined);
});

test("bounds event lines, accepts the exact limit, and resumes after overlong input", () => {
	const emptyEvent = messageEnd([""], { ending: "" });
	const overhead = emptyEvent.length;
	const exactText = "x".repeat(MAX_EVENT_LINE_BYTES - overhead);
	const exactLine = messageEnd([exactText], { ending: "" });
	assert.equal(exactLine.length, MAX_EVENT_LINE_BYTES);
	assert.deepEqual(capture(exactLine), Buffer.from(exactText));

	const overlong = messageEnd([`${exactText}x`]);
	assert.ok(overlong.length > MAX_EVENT_LINE_BYTES);
	assert.deepEqual(capture(overlong, messageEnd(["after overlong"])), Buffer.from("after overlong"));

	const priorThenUnterminated = new PiJsonFinalCapture();
	priorThenUnterminated.write(messageEnd(["prior"]));
	priorThenUnterminated.write(overlong.subarray(0, -1));
	assert.deepEqual(priorThenUnterminated.finish(), Buffer.from("prior"));
});
