import assert from "node:assert/strict";
import test from "node:test";

import { createChildRunId } from "../src/loop-state.ts";

test("child run ids are opaque filesystem-safe values independent of the requested agent name", () => {
	const childId = createChildRunId();

	assert.match(childId, /^child-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	assert.doesNotMatch(childId, /untrusted|\.\.|[/\\;$()]/);
	assert.notEqual(createChildRunId(), childId);
});
