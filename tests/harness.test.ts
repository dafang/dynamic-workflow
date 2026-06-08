import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNESS_ALLOWED_PRIMITIVES,
  HARNESS_DENIED_CAPABILITIES,
  compileHarnessToPlan
} from "../src/harness.js";
import { compilePlan } from "../src/index.js";

test("documents allowed SDK primitives and denied capabilities", () => {
  assert.deepEqual([...HARNESS_ALLOWED_PRIMITIVES], [
    "agent",
    "parallel",
    "pipeline",
    "loop",
    "judge",
    "artifact.read",
    "artifact.write",
    "askUser"
  ]);
  assert.ok(HARNESS_DENIED_CAPABILITIES.includes("fs"));
  assert.ok(HARNESS_DENIED_CAPABILITIES.includes("child_process"));
  assert.ok(HARNESS_DENIED_CAPABILITIES.includes("process.env"));
  assert.ok(HARNESS_DENIED_CAPABILITIES.includes("fetch"));
  assert.ok(HARNESS_DENIED_CAPABILITIES.includes("eval("));
});

test("compiles JS harness fan-out and synthesize into equivalent typed plan structure", () => {
  const source = `
const results = await parallel([
  agent("Review gateway", { role: "reviewer", step_id: "review_gateway" }),
  agent("Review runtime", { role: "reviewer", step_id: "review_runtime" })
])
return await agent("Merge findings", { role: "synthesizer", step_id: "synthesize", input: results })
`;
  const fromHarness = compileHarnessToPlan(source, "dwf_harness_equiv");
  const fromYaml = compilePlan({
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: "dwf_harness_equiv",
    kind: "mixed",
    steps: [
      { step_id: "review_gateway", type: "agent.review", permission_profile: "reviewer_readonly", input: { prompt: "Review gateway" }, depends_on: [] },
      { step_id: "review_runtime", type: "agent.review", permission_profile: "reviewer_readonly", input: { prompt: "Review runtime" }, depends_on: [] },
      { step_id: "synthesize", type: "agent.synthesize", permission_profile: "synthesizer", input: { prompt: "Merge findings" }, depends_on: ["review_gateway", "review_runtime"] }
    ]
  });
  assert.deepEqual(
    fromHarness.manifest.nodes.map((node) => ({ id: node.step_id, type: node.type, deps: node.depends_on })),
    fromYaml.nodes.map((node) => ({ id: node.step_id, type: node.type, deps: node.depends_on }))
  );
});

test("rejects disallowed JS and system capabilities", () => {
  for (const source of [
    'import fs from "node:fs"',
    'const fs = require("fs")',
    'await import("node:fs")',
    "process.env.SECRET",
    "process?.env?.SECRET",
    'process["env"].SECRET',
    "fetch('https://example.com')",
    "globalThis['fetch']('https://example.com')",
    "eval('1 + 1')",
    "Function('return process')()",
    "new Function('return process')",
    'global["process"]',
    'window["process"]',
    'self["fetch"]',
    "globalThis.process",
    "({}).constructor",
    "({}).constructor.constructor('return process')()",
    '({})["constructor"]["constructor"]("return process")()',
    'safeHandle["constructor"]',
    "agent(`dynamic ${process.env.SECRET}`)"
  ]) {
    assert.throws(() => compileHarnessToPlan(source), /Harness denied capability/);
  }
});

test("does not reject denied capability words inside prompts or comments", () => {
  const source = `
// mention process.env and fetch in comments without using them
agent("Explain why fs and fetch are denied", { step_id: "explain" })
agent(\`Mention process.env, fs, fetch, and Function without interpolation\`, { step_id: "explain_template" })
`;
  const result = compileHarnessToPlan(source, "dwf_harness_prompt_words");
  assert.equal(result.plan.steps[0]?.step_id, "explain");
  assert.equal(result.plan.steps[1]?.step_id, "explain_template");
});

test("ignores workflow SDK calls inside comments while capturing harness steps", () => {
  const source = `
// agent("Commented fake step", { step_id: "fake" })
/*
parallel([agent("Fake branch", { step_id: "fake_branch" })])
loop(() => agent("Fake loop", { step_id: "fake_loop" }))
judge()
*/
agent("Real work", { step_id: "real" })
`;
  const result = compileHarnessToPlan(source, "dwf_harness_comments");
  assert.deepEqual(
    result.plan.steps.map((step) => step.step_id),
    ["real"]
  );
});

test("captures sequential agents as dependencies after fan-out synthesis", () => {
  const source = `
const reviews = await parallel([
  agent("Review gateway", { role: "reviewer", step_id: "review_gateway" }),
  agent("Review runtime", { role: "reviewer", step_id: "review_runtime" })
])
const synthesis = await agent("Merge findings", { role: "synthesizer", step_id: "synthesize", input: reviews })
await agent("Adversarial review", { role: "reviewer", step_id: "adversarial_review", input: synthesis })
`;
  const result = compileHarnessToPlan(source, "dwf_harness_sequence");
  assert.deepEqual(result.manifest.dependencies.synthesize, ["review_gateway", "review_runtime"]);
  assert.deepEqual(result.manifest.dependencies.adversarial_review, ["synthesize"]);
});

test("updates dependencies when duplicate harness step ids are deduplicated", () => {
  const source = `
const reviews = await parallel([
  agent("Review gateway", { role: "reviewer", step_id: "review" }),
  agent("Review runtime", { role: "reviewer", step_id: "review" })
])
await agent("Merge findings", { role: "synthesizer", step_id: "synthesize", input: reviews })
`;
  const result = compileHarnessToPlan(source, "dwf_harness_dedupe");
  assert.deepEqual(
    result.plan.steps.map((step) => step.step_id),
    ["review", "review_2", "synthesize"]
  );
  assert.deepEqual(result.manifest.dependencies.synthesize, ["review", "review_2"]);
});

test("backend remains current by default and external backends fail closed", () => {
  const result = compileHarnessToPlan('agent("Implement", { step_id: "implement" })', "dwf_backend_default");
  assert.equal(result.manifest.nodes[0]?.backend, "current");
  assert.throws(
    () =>
      compilePlan({
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "dwf_external",
        kind: "mixed",
        steps: [{ step_id: "x", type: "agent.execute", backend: "acp", depends_on: [] }]
      }),
    /unsupported_backend/
  );
});
