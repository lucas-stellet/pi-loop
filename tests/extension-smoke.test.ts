import assert from "node:assert/strict";
import test from "node:test";

import piLoop from "../index.ts";

test("pi-loop exports a callable Pi extension factory", () => {
  assert.equal(typeof piLoop, "function");
  assert.doesNotThrow(() => piLoop({} as never));
});
