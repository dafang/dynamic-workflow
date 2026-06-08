import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditRun } from "../src/audit.js";
import { compilePlan } from "../src/compiler.js";
import { runWorkflow } from "../src/runtime.js";
import { initialStepStates } from "../src/scheduler.js";
import type { WorkflowPlan } from "../src/index.js";

function plan(steps: WorkflowPlan["steps"]): WorkflowPlan {
  return {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: "dwf_runtime_test",
    kind: "mixed",
    steps
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "dw-runtime-"));
}

test("runtime creates durable run tree, trace, step outputs, and completes audit", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      { step_id: "execute", type: "agent.execute", depends_on: [] },
      { step_id: "verify", type: "command.verify", depends_on: ["execute"], input: { commands: ["node --version"] } }
    ]),
    { rootDir, runId: "run_happy" }
  );
  assert.equal(result.record.state, "completed");
  assert.equal(result.audit.ok, true);
  assert.ok(result.markers.includes("DW_RUN_COMPLETE"));
  const files = await readdir(result.record.run_dir);
  assert.ok(files.includes("plan.yaml"));
  assert.ok(files.includes("compiled_manifest.json"));
  assert.ok(files.includes("trace.jsonl"));
  assert.ok(files.includes("steps"));
  assert.ok(files.includes("artifacts"));
  const trace = await readFile(path.join(result.record.run_dir, "trace.jsonl"), "utf8");
  assert.match(trace, /workflow_created/);
  assert.match(trace, /step_started/);
  assert.match(trace, /step_succeeded/);
  assert.match(trace, /workflow_completed/);
});

test("command.verify executes commands declared in verify.commands", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "verify",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["node --version"] }
      }
    ]),
    { rootDir, runId: "run_verify_contract" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "verify.json"), "utf8");
  const artifact = JSON.parse(text) as { output: { checks: Array<{ command: string; exit_code: number }> } };
  assert.equal(artifact.output.checks.length, 1);
  assert.equal(artifact.output.checks[0]?.command, "node --version");
  assert.equal(artifact.output.checks[0]?.exit_code, 0);
});

test("command.verify fails validation when no commands are declared", () => {
  assert.throws(
    () =>
      compilePlan({
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "missing_verify_commands",
        kind: "mixed",
        steps: [{ step_id: "verify", type: "command.verify", depends_on: [] }]
      }),
    /missing_verify_commands/
  );
});

test("workflow.include can be used as a dependency target for downstream skipped branches", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "classify",
        type: "agent.classify",
        depends_on: []
      },
      {
        step_id: "feature_flow",
        type: "workflow.include",
        depends_on: ["classify"],
        input: { workflow_ref: "builtin.feature" },
        run_if: { step: "classify", output_path: "label", op: "==", value: "feature" }
      },
      {
        step_id: "summarize",
        type: "agent.synthesize",
        depends_on: ["feature_flow"],
        input: { resource_scope: "summary" }
      }
    ]),
    { rootDir, runId: "run_include_skip" }
  );
  assert.equal(result.record.state, "completed");
  assert.equal(result.audit.ok, true);
  assert.equal(result.record.steps.feature_flow__implement?.state, "skipped");
  assert.equal(result.record.steps.feature_flow__review?.state, "skipped");
  assert.equal(result.record.steps.summarize?.state, "succeeded");
  assert.deepEqual(result.manifest.dependencies.summarize, ["feature_flow__review"]);
});

test("run_if reads step output fields and executes true branches", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "review",
        type: "agent.review",
        depends_on: []
      },
      {
        step_id: "summarize",
        type: "agent.synthesize",
        depends_on: ["review"],
        input: { resource_scope: "summary" },
        run_if: { step: "review", output_path: "status", op: "==", value: "succeeded" }
      }
    ]),
    { rootDir, runId: "run_if_true" }
  );
  assert.equal(result.record.state, "completed");
  assert.equal(result.audit.ok, true);
  assert.equal(result.record.steps.summarize?.state, "succeeded");
});

test("run_if can target control step ids after compiler rewrites to terminal nodes", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "repair_loop",
        type: "workflow.loop",
        depends_on: [],
        input: { max_rounds: 2, stop_condition: "ready" }
      },
      {
        step_id: "synthesize",
        type: "agent.synthesize",
        depends_on: ["repair_loop"],
        input: { resource_scope: "summary" },
        run_if: { step: "repair_loop", output_path: "status", op: "==", value: "succeeded" }
      }
    ]),
    { rootDir, runId: "run_if_control_true" }
  );
  assert.equal(result.record.state, "completed");
  assert.equal(result.audit.ok, true);
  assert.equal(result.record.steps.synthesize?.state, "succeeded");
  assert.equal(result.manifest.nodes.find((node) => node.step_id === "synthesize")?.run_if?.step, "repair_loop__round_2");
});

test("workflow.tournament and workflow.loop controls can be chained as dependency targets", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "candidate_a",
        type: "agent.generate",
        depends_on: [],
        input: { resource_scope: "candidate_a" }
      },
      {
        step_id: "candidate_b",
        type: "agent.generate",
        depends_on: [],
        input: { resource_scope: "candidate_b" }
      },
      {
        step_id: "candidate_c",
        type: "agent.generate",
        depends_on: [],
        input: { resource_scope: "candidate_c" }
      },
      {
        step_id: "tournament",
        type: "workflow.tournament",
        depends_on: ["candidate_a", "candidate_b", "candidate_c"],
        input: {
          candidate_steps: ["candidate_a", "candidate_b", "candidate_c"],
          criteria: ["correctness", "risk"]
        }
      },
      {
        step_id: "repair_loop",
        type: "workflow.loop",
        depends_on: ["tournament"],
        input: { max_rounds: 2, stop_condition: "tests_pass" }
      },
      {
        step_id: "synthesize",
        type: "agent.synthesize",
        depends_on: ["repair_loop"],
        input: { resource_scope: "summary" }
      },
      {
        step_id: "verify_commands",
        type: "command.verify",
        depends_on: ["synthesize"],
        verify: { commands: ["node --version"] }
      }
    ]),
    { rootDir, runId: "run_loop_tournament_chain" }
  );
  assert.equal(result.record.state, "completed");
  assert.equal(result.audit.ok, true);
  assert.ok(result.markers.includes("DW_RUN_COMPLETE"));
  assert.deepEqual(result.manifest.dependencies.repair_loop__round_1, ["tournament__judge_2"]);
  assert.deepEqual(result.manifest.dependencies.synthesize, ["repair_loop__round_2"]);
  assert.equal(result.record.steps.tournament__judge_1?.state, "succeeded");
  assert.equal(result.record.steps.tournament__judge_2?.state, "succeeded");
  assert.equal(result.record.steps.repair_loop__round_1?.state, "succeeded");
  assert.equal(result.record.steps.repair_loop__round_2?.state, "succeeded");
  assert.equal(result.record.steps.verify_commands?.state, "succeeded");
});

test("failed steps block downstream dependents and write failure trace", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      { step_id: "fail", type: "agent.execute", depends_on: [], input: { force_fail: true } },
      { step_id: "downstream", type: "agent.review", depends_on: ["fail"] }
    ]),
    { rootDir, runId: "run_failed" }
  );
  assert.equal(result.record.state, "failed");
  assert.equal(result.record.steps.fail?.state, "failed");
  assert.equal(result.record.steps.downstream?.state, "blocked");
  const trace = await readFile(path.join(result.record.run_dir, "trace.jsonl"), "utf8");
  assert.match(trace, /step_failed/);
});

test("current backend is default and external backends are rejected before execution", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(plan([{ step_id: "default_backend", type: "agent.review", depends_on: [] }]), {
    rootDir,
    runId: "run_current"
  });
  assert.equal(result.record.state, "completed");
  assert.throws(
    () =>
      compilePlan({
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "bad_backend",
        kind: "mixed",
        steps: [{ step_id: "x", type: "agent.review", backend: "codex", depends_on: [] }]
      }),
    /unsupported_backend/
  );
});

test("artifact output redacts secrets and raw prompts", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "execute",
        type: "agent.execute",
        depends_on: [],
        input: { token: "secret", raw_prompt: "hidden" }
      }
    ]),
    { rootDir, runId: "run_redact" }
  );
  const text = await readFile(path.join(result.record.run_dir, "steps", "execute.json"), "utf8");
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /hidden/);
});

test("audit fails when terminal states or artifacts are missing", async () => {
  const manifest = compilePlan(plan([{ step_id: "execute", type: "agent.execute", depends_on: [] }]));
  const steps = initialStepStates(manifest);
  const rootDir = await tempRoot();
  const audit = await auditRun({ runDir: rootDir, workflowState: "running", manifest, steps });
  assert.equal(audit.ok, false);
  assert.ok(audit.findings.some((finding) => finding.code === "workflow_not_completed"));
  assert.ok(audit.findings.some((finding) => finding.code === "non_terminal_success_step"));
});
