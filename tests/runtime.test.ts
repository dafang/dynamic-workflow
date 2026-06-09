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

test("command.verify executes commands declared in verify.commands and emits command trace metadata", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "verify",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["node --version", "node -e \"process.stdout.write(String.fromCharCode(115,101,99,111,110,100))\""] }
      }
    ]),
    { rootDir, runId: "run_verify_contract" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "verify.json"), "utf8");
  const artifact = JSON.parse(text) as {
    output: {
      checks: Array<{
        command: string;
        exit_code: number;
        elapsed_ms: number;
        timed_out: boolean;
        stdout_bytes: number;
        stderr_bytes: number;
        acceptable: boolean;
      }>;
    };
  };
  assert.equal(artifact.output.checks.length, 2);
  assert.equal(artifact.output.checks[0]?.command, "node --version");
  assert.equal(artifact.output.checks[0]?.exit_code, 0);
  assert.equal(artifact.output.checks[0]?.timed_out, false);
  assert.equal(artifact.output.checks[0]?.acceptable, true);
  assert.equal(typeof artifact.output.checks[0]?.elapsed_ms, "number");
  assert.equal(artifact.output.checks[1]?.stdout_bytes, 6);

  const trace = await readFile(path.join(result.record.run_dir, "trace.jsonl"), "utf8");
  const events = trace
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
  const commandStarted = events.filter((event) => event.event === "command_started");
  const commandFinished = events.filter((event) => event.event === "command_finished");
  assert.equal(commandStarted.length, 2);
  assert.equal(commandFinished.length, 2);
  assert.deepEqual(commandStarted.map((event) => event.data?.command_index), [0, 1]);
  assert.equal(commandStarted[0]?.data?.command_preview, "node --version");
  assert.equal(commandFinished[0]?.data?.timed_out, false);
  assert.equal(typeof commandFinished[0]?.data?.elapsed_ms, "number");
  assert.equal(commandFinished[1]?.data?.stdout_bytes, 6);
  for (const event of [...commandStarted, ...commandFinished]) {
    assert.equal(Object.hasOwn(event.data ?? {}, "stdout"), false, "trace should not include raw stdout");
    assert.equal(Object.hasOwn(event.data ?? {}, "stderr"), false, "trace should not include raw stderr");
  }
});

test("command.verify caps command stdout in artifacts while recording original byte counts", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "verify",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["node -e \"process.stdout.write('x'.repeat(2505))\""] }
      }
    ]),
    { rootDir, runId: "run_command_output_cap" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "verify.json"), "utf8");
  const artifact = JSON.parse(text) as { output: { checks: Array<{ stdout: string; stdout_bytes: number; stdout_truncated: boolean }> } };
  assert.equal(artifact.output.checks[0]?.stdout.length, 2000);
  assert.equal(artifact.output.checks[0]?.stdout_bytes, 2505);
  assert.equal(artifact.output.checks[0]?.stdout_truncated, true);
});

test("command.verify records non-zero command failure category and blocks downstream", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "verify",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["node -e \"process.exit(7)\""] }
      },
      { step_id: "after", type: "agent.review", depends_on: ["verify"] }
    ]),
    { rootDir, runId: "run_command_nonzero" }
  );
  assert.equal(result.record.state, "failed");
  assert.equal(result.record.steps.after?.state, "blocked");
  const artifactText = await readFile(path.join(result.record.run_dir, "steps", "verify.json"), "utf8");
  const artifact = JSON.parse(artifactText) as {
    output: { checks: Array<{ exit_code: number; timed_out: boolean; failure_category: string; repair_hint: string }> };
  };
  assert.equal(artifact.output.checks[0]?.exit_code, 7);
  assert.equal(artifact.output.checks[0]?.timed_out, false);
  assert.equal(artifact.output.checks[0]?.failure_category, "nonzero_exit");
  assert.match(artifact.output.checks[0]?.repair_hint ?? "", /stdout\/stderr|failing invariant/);

  const trace = await readFile(path.join(result.record.run_dir, "trace.jsonl"), "utf8");
  assert.match(trace, /command_failed/);
  assert.match(trace, /nonzero_exit/);
});

test("command.verify distinguishes timeout failures from normal non-zero exits in artifacts and trace", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "verify",
        type: "command.verify",
        depends_on: [],
        input: { timeout_seconds: 0.2 },
        verify: { commands: ["node -e \"setTimeout(() => {}, 130000)\""] }
      }
    ]),
    { rootDir, runId: "run_command_timeout" }
  );
  assert.equal(result.record.state, "failed");
  const artifactText = await readFile(path.join(result.record.run_dir, "steps", "verify.json"), "utf8");
  const artifact = JSON.parse(artifactText) as {
    output: {
      checks: Array<{ exit_code: number | null; signal: string | null; timed_out: boolean; failure_category: string; repair_hint: string }>;
    };
  };
  assert.equal(artifact.output.checks[0]?.timed_out, true);
  assert.equal(artifact.output.checks[0]?.failure_category, "timeout");
  assert.match(artifact.output.checks[0]?.repair_hint ?? "", /Narrow the command scope/);

  const trace = await readFile(path.join(result.record.run_dir, "trace.jsonl"), "utf8");
  assert.match(trace, /command_finished/);
  assert.match(trace, /command_failed/);
  assert.match(trace, /"timed_out":true/);
  assert.match(trace, /"failure_category":"timeout"/);
});

test("command.collect records no-match and missing optional evidence gaps while downstream consumes partial checks", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "collect",
        type: "command.collect",
        permission_profile: "command_collector",
        depends_on: [],
        collect: {
          commands: [
            {
              id: "hit",
              run: "printf collected-docs",
              stdout_max_bytes: 50
            },
            {
              id: "no_match",
              run: "tmp=$(mktemp -d); printf haystack > \"$tmp/file.txt\"; rg __dynamic_workflow_no_match__ \"$tmp/file.txt\"",
              allow_exit_codes: [0],
              soft_fail: true
            },
            {
              id: "missing_path",
              run: "ls ./__dynamic_workflow_missing_path__",
              soft_fail: true
            }
          ]
        }
      },
      {
        step_id: "synthesize",
        type: "agent.synthesize",
        depends_on: ["collect"],
        consumes: [{ from: "collect", select: "$.output.collection.checks[*].stdout", as: "collected" }]
      }
    ]),
    { rootDir, runId: "run_collect_partial" }
  );
  assert.equal(result.record.state, "completed");
  assert.equal(result.record.steps.collect?.state, "succeeded");
  assert.equal(result.record.steps.synthesize?.state, "succeeded");
  const collectText = await readFile(path.join(result.record.run_dir, "steps", "collect.json"), "utf8");
  const collectArtifact = JSON.parse(collectText) as {
    output: {
      collection: {
        ok: boolean;
        checks: Array<{ id: string; stdout: string; acceptable: boolean; soft_failed: boolean; failure_category?: string }>;
        gaps: Array<{ id: string; failure_category: string; soft_failed: boolean }>;
      };
    };
  };
  assert.equal(collectArtifact.output.collection.ok, true);
  assert.equal(collectArtifact.output.collection.checks[0]?.stdout, "collected-docs");
  assert.deepEqual(
    collectArtifact.output.collection.gaps.map((gap) => [gap.id, gap.failure_category, gap.soft_failed]),
    [
      ["no_match", "no_match", true],
      ["missing_path", "missing_path", true]
    ]
  );
  const synthesizeText = await readFile(path.join(result.record.run_dir, "steps", "synthesize.json"), "utf8");
  assert.match(synthesizeText, /collected-docs/);
});

test("command.verify remains strict when a non-zero exit is not explicitly allowed", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "verify",
        type: "command.verify",
        depends_on: [],
        verify: {
          commands: [{ id: "strict", run: "node -e \"process.exit(1)\"" }]
        }
      }
    ]),
    { rootDir, runId: "run_verify_still_strict" }
  );
  assert.equal(result.record.state, "failed");
  assert.equal(result.record.steps.verify?.state, "failed");
  const artifactText = await readFile(path.join(result.record.run_dir, "steps", "verify.json"), "utf8");
  const artifact = JSON.parse(artifactText) as { verify: { ok: boolean }; output: { checks: Array<{ acceptable: boolean }> } };
  assert.equal(artifact.verify.ok, false);
  assert.equal(artifact.output.checks[0]?.acceptable, false);
});

test("runtime injects command output into downstream agent context", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "collect",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["printf docs-context"] }
      },
      {
        step_id: "review",
        type: "agent.review",
        depends_on: ["collect"],
        input: { prompt: "Review docs" },
        consumes: [{ from: "collect", select: "$.verify.checks[*].stdout", as: "docs" }]
      }
    ]),
    { rootDir, runId: "run_context_injection" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "review.json"), "utf8");
  const artifact = JSON.parse(text) as {
    output: { context: { docs: string[] }; context_sources: Array<{ alias: string; from_step: string; selected_path: string }> };
  };
  assert.deepEqual(artifact.output.context.docs, ["docs-context"]);
  assert.deepEqual(artifact.output.context_sources[0], {
    alias: "docs",
    from_step: "collect",
    output_path: path.join(result.record.run_dir, "steps", "collect.json"),
    selected_path: "$.verify.checks[*].stdout",
    required: true,
    clipped: false,
    original_bytes: 16,
    selected_bytes: 16
  });
});

test("missing required context fails step and blocks downstream", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "collect",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["printf ready"] }
      },
      {
        step_id: "review",
        type: "agent.review",
        depends_on: ["collect"],
        consumes: [{ from: "collect", select: "$.output.missing", as: "missing" }]
      },
      {
        step_id: "synthesize",
        type: "agent.synthesize",
        depends_on: ["review"]
      }
    ]),
    { rootDir, runId: "run_required_context_missing" }
  );
  assert.equal(result.record.state, "failed");
  assert.equal(result.record.steps.review?.state, "failed");
  assert.equal(result.record.steps.synthesize?.state, "blocked");
  const text = await readFile(path.join(result.record.run_dir, "steps", "review.json"), "utf8");
  assert.match(text, /context_error/);
});

test("optional missing context records empty source without failing", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "collect",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["printf ready"] }
      },
      {
        step_id: "review",
        type: "agent.review",
        depends_on: ["collect"],
        consumes: [{ from: "collect", select: "$.output.missing", as: "optional_docs", required: false }]
      }
    ]),
    { rootDir, runId: "run_optional_context_missing" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "review.json"), "utf8");
  const artifact = JSON.parse(text) as {
    output: { context: Record<string, unknown>; context_sources: Array<{ alias: string; required: boolean; selected_path: string }> };
  };
  assert.deepEqual(artifact.output.context, {});
  assert.equal(artifact.output.context_sources[0]?.alias, "optional_docs");
  assert.equal(artifact.output.context_sources[0]?.required, false);
  assert.match(artifact.output.context_sources[0]?.selected_path ?? "", /missing_selector/);
});

test("context clipping records stable byte metadata", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "collect",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["printf abcdefghij"] }
      },
      {
        step_id: "review",
        type: "agent.review",
        depends_on: ["collect"],
        consumes: [{ from: "collect", select: "$.verify.checks[*].stdout", as: "docs", max_bytes: 5 }]
      }
    ]),
    { rootDir, runId: "run_context_clip" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "review.json"), "utf8");
  const artifact = JSON.parse(text) as {
    output: { context: { docs: string }; context_sources: Array<{ clipped: boolean; original_bytes: number; selected_bytes: number }> };
  };
  assert.equal(artifact.output.context.docs, "[\"abc");
  assert.equal(artifact.output.context_sources[0]?.clipped, true);
  assert.equal(artifact.output.context_sources[0]?.original_bytes, 14);
  assert.equal(artifact.output.context_sources[0]?.selected_bytes, 5);
});

test("context clipping does not split multibyte characters", async () => {
  const rootDir = await tempRoot();
  const result = await runWorkflow(
    plan([
      {
        step_id: "collect",
        type: "command.verify",
        depends_on: [],
        verify: { commands: ["node -e \"process.stdout.write('\\u4f60\\u597d\\u4e16\\u754c')\""] }
      },
      {
        step_id: "review",
        type: "agent.review",
        depends_on: ["collect"],
        consumes: [{ from: "collect", select: "$.verify.checks[*].stdout", as: "docs", max_bytes: 6 }]
      }
    ]),
    { rootDir, runId: "run_context_unicode_clip" }
  );
  assert.equal(result.record.state, "completed");
  const text = await readFile(path.join(result.record.run_dir, "steps", "review.json"), "utf8");
  const artifact = JSON.parse(text) as {
    output: { context: { docs: string }; context_sources: Array<{ clipped: boolean; selected_bytes: number }> };
  };
  assert.equal(artifact.output.context.docs, "[\"\u4f60");
  assert.equal(artifact.output.context.docs.includes("\uFFFD"), false);
  assert.equal(artifact.output.context_sources[0]?.clipped, true);
  assert.ok((artifact.output.context_sources[0]?.selected_bytes ?? 0) <= 6);
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
