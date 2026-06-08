import assert from "node:assert/strict";
import test from "node:test";

import { compilePlan } from "../src/compiler.js";
import type { WorkflowPlan } from "../src/index.js";

function plan(steps: WorkflowPlan["steps"]): WorkflowPlan {
  return {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: "dwf_compile_test",
    kind: "mixed",
    budget: { max_steps: 50, max_subagents: 10, max_rounds: 5 },
    steps
  };
}

test("compiles fan-out branches with deterministic ready queue and synthesize dependency", () => {
  const manifest = compilePlan(
    plan([
      { step_id: "review_gateway", type: "agent.review", depends_on: [], input: { resource_scope: "gateway" } },
      { step_id: "review_runtime", type: "agent.review", depends_on: [], input: { resource_scope: "runtime" } },
      { step_id: "synthesize", type: "agent.synthesize", depends_on: ["review_gateway", "review_runtime"] }
    ])
  );
  assert.deepEqual(manifest.ready_queue, ["review_gateway", "review_runtime"]);
  assert.deepEqual(manifest.dependencies.synthesize, ["review_gateway", "review_runtime"]);
  assert.deepEqual(manifest.reverse_dependencies.review_gateway, ["synthesize"]);
  assert.equal(manifest.budget_summary.executable_nodes, 3);
});

test("expands allowlisted workflow includes and rejects unknown refs", () => {
  const manifest = compilePlan(
    plan([
      {
        step_id: "feature_flow",
        type: "workflow.include",
        depends_on: [],
        input: { workflow_ref: "builtin.feature" }
      }
    ])
  );
  assert.deepEqual(
    manifest.nodes.map((node) => node.step_id),
    ["feature_flow__implement", "feature_flow__review"]
  );
  assert.throws(
    () =>
      compilePlan(
        plan([
          {
            step_id: "external_flow",
            type: "workflow.include",
            depends_on: [],
            input: { workflow_ref: "custom.remote" }
          }
        ])
      ),
    /Unsupported workflow.include/
  );
});

test("rewrites dependencies on workflow.include controls to terminal expanded nodes", () => {
  const manifest = compilePlan(
    plan([
      {
        step_id: "feature_flow",
        type: "workflow.include",
        depends_on: [],
        input: { workflow_ref: "builtin.feature" }
      },
      {
        step_id: "summarize",
        type: "agent.synthesize",
        input: { resource_scope: "summary" },
        depends_on: ["feature_flow"]
      }
    ])
  );
  assert.deepEqual(manifest.dependencies.summarize, ["feature_flow__review"]);
  assert.deepEqual(manifest.reverse_dependencies.feature_flow__review, ["summarize"]);
});

test("rewrites dependencies on workflow.loop controls to the final round", () => {
  const manifest = compilePlan(
    plan([
      {
        step_id: "repair_loop",
        type: "workflow.loop",
        depends_on: [],
        input: { max_rounds: 2, stop_condition: "tests_pass" }
      },
      {
        step_id: "summarize",
        type: "agent.synthesize",
        input: { resource_scope: "summary" },
        depends_on: ["repair_loop"]
      }
    ])
  );
  assert.deepEqual(manifest.dependencies.summarize, ["repair_loop__round_2"]);
  assert.deepEqual(manifest.reverse_dependencies.repair_loop__round_2, ["summarize"]);
});

test("rewrites dependencies on workflow.tournament controls to the final judge", () => {
  const manifest = compilePlan(
    plan([
      { step_id: "candidate_a", type: "agent.generate", depends_on: [] },
      { step_id: "candidate_b", type: "agent.generate", depends_on: [] },
      { step_id: "candidate_c", type: "agent.generate", depends_on: [] },
      {
        step_id: "tournament",
        type: "workflow.tournament",
        depends_on: ["candidate_a", "candidate_b", "candidate_c"],
        input: { candidate_steps: ["candidate_a", "candidate_b", "candidate_c"], criteria: ["correctness"] }
      },
      {
        step_id: "repair_loop",
        type: "workflow.loop",
        depends_on: ["tournament"],
        input: { max_rounds: 2, stop_condition: "tests_pass" }
      },
      {
        step_id: "summarize",
        type: "agent.synthesize",
        input: { resource_scope: "summary" },
        depends_on: ["repair_loop"]
      }
    ])
  );
  assert.deepEqual(manifest.dependencies.repair_loop__round_1, ["tournament__judge_2"]);
  assert.deepEqual(manifest.dependencies.summarize, ["repair_loop__round_2"]);
});

test("rewrites run_if references on control ids to terminal expanded nodes", () => {
  const manifest = compilePlan(
    plan([
      {
        step_id: "feature_flow",
        type: "workflow.include",
        depends_on: [],
        input: { workflow_ref: "builtin.feature" }
      },
      {
        step_id: "conditional_summary",
        type: "agent.synthesize",
        input: { resource_scope: "summary" },
        depends_on: ["feature_flow"],
        run_if: { step: "feature_flow", output_path: "status", op: "==", value: "succeeded" }
      }
    ])
  );
  assert.equal(manifest.nodes.find((node) => node.step_id === "conditional_summary")?.run_if?.step, "feature_flow__review");
});

test("expands workflow loops into bounded round steps with stop condition", () => {
  const manifest = compilePlan(
    plan([
      {
        step_id: "repair_loop",
        type: "workflow.loop",
        depends_on: [],
        input: { max_rounds: 3, stop_condition: "tests_pass" }
      }
    ])
  );
  assert.deepEqual(
    manifest.nodes.map((node) => node.step_id),
    ["repair_loop__round_1", "repair_loop__round_2", "repair_loop__round_3"]
  );
  assert.equal(manifest.nodes[0]?.input.stop_condition, "tests_pass");
  assert.deepEqual(manifest.dependencies.repair_loop__round_2, ["repair_loop__round_1"]);
});

test("expands workflow tournaments into deterministic pairwise judges", () => {
  const manifest = compilePlan(
    plan([
      { step_id: "candidate_a", type: "agent.generate", depends_on: [] },
      { step_id: "candidate_b", type: "agent.generate", depends_on: [] },
      { step_id: "candidate_c", type: "agent.generate", depends_on: [] },
      {
        step_id: "tournament",
        type: "workflow.tournament",
        depends_on: ["candidate_a", "candidate_b", "candidate_c"],
        input: { candidate_steps: ["candidate_a", "candidate_b", "candidate_c"], criteria: ["correctness"] }
      }
    ])
  );
  assert.ok(manifest.nodes.some((node) => node.step_id === "tournament__judge_1"));
  assert.ok(manifest.nodes.some((node) => node.step_id === "tournament__judge_2"));
  assert.deepEqual(manifest.dependencies.tournament__judge_1, ["candidate_a", "candidate_b"]);
  assert.deepEqual(manifest.dependencies.tournament__judge_2, ["candidate_c", "tournament__judge_1"]);
});

test("preserves run_if conditions and rejects invalid output paths", () => {
  const manifest = compilePlan(
    plan([
      { step_id: "review", type: "agent.review", depends_on: [] },
      {
        step_id: "fix",
        type: "agent.execute",
        depends_on: ["review"],
        run_if: { step: "review", output_path: "blocking.length", op: ">", value: 0 }
      }
    ])
  );
  assert.equal(manifest.nodes.find((node) => node.step_id === "fix")?.run_if?.output_path, "blocking.length");
  assert.throws(
    () =>
      compilePlan(
        plan([
          { step_id: "review", type: "agent.review", depends_on: [] },
          {
            step_id: "fix",
            type: "agent.execute",
            depends_on: ["review"],
            run_if: { step: "review", output_path: "blocking[0]", op: "exists" }
          }
        ])
      ),
    /invalid output path/
  );
});

test("assigns write locks and preserves original plan snapshot", () => {
  const source = plan([
    { step_id: "write_a", type: "agent.execute", depends_on: [], input: { resource_scope: "repo" } },
    { step_id: "write_b", type: "agent.execute", depends_on: [], input: { resource_scope: "repo" } }
  ]);
  const manifest = compilePlan(source);
  assert.deepEqual(manifest.writer_conflicts.repo, ["write_a", "write_b"]);
  assert.deepEqual(
    manifest.resource_locks.filter((lock) => lock.mode === "write").map((lock) => lock.step_id),
    ["write_a", "write_b"]
  );
  source.steps[0]!.step_id = "mutated_after_compile";
  assert.equal(manifest.original_plan.steps[0]?.step_id, "write_a");
});
