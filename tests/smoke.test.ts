import assert from "node:assert/strict";
import test from "node:test";

import { DYNAMIC_WORKFLOW_VERSION, getRuntimeBanner } from "../src/index.js";

test("exports runtime version", () => {
  assert.equal(DYNAMIC_WORKFLOW_VERSION, "0.1.0");
  assert.equal(getRuntimeBanner(), "dynamic-workflow 0.1.0");
});
