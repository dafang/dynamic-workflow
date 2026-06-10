import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { compileHarnessToPlan } from "../src/harness.js";
import { readJson } from "../src/artifacts.js";
import { compilePlan } from "../src/compiler.js";
import { runWorkflow } from "../src/runtime.js";
import { STEP_REGISTRY } from "../src/registry.js";
import type { JsonObject, WorkflowPlan, WorkflowStep } from "../src/types.js";

const execFileAsync = promisify(execFile);
const binPath = path.resolve("bin/dw.mjs");
const MATRIX_PATH = path.resolve("tests/fixtures/workflow-mode-matrix.md");

interface StepArtifact {
  output: JsonObject;
}

function plan(workflowId: string, steps: WorkflowStep[]): WorkflowPlan {
  return {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: workflowId,
    kind: "mixed",
    steps
  };
}

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTempModule(): Promise<{ moduleDir: string; verifierCommand: string; reportPath: string }> {
  const moduleDir = await tempRoot("dw-mode-module-");
  const sourcePath = path.join(moduleDir, "src", "math.ts");
  const reportPath = path.join(moduleDir, "REPORT.md");
  const verifierPath = path.join(moduleDir, "verify.cjs");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(path.join(moduleDir, "package.json"), `${JSON.stringify({ name: "dw-mode-module", type: "module" }, null, 2)}\n`, "utf8");
  await writeFile(sourcePath, "export function add(left: number, right: number): number {\n  return left + right;\n}\n", "utf8");
  await writeFile(reportPath, "# Module Evidence\n\n- API: add(left, right)\n- Edge case: zero operands\n", "utf8");
  await writeFile(
    verifierPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const moduleDir = ${JSON.stringify(moduleDir)};`,
      "const source = fs.readFileSync(path.join(moduleDir, 'src', 'math.ts'), 'utf8');",
      "const report = fs.readFileSync(path.join(moduleDir, 'REPORT.md'), 'utf8');",
      "if (!source.includes('function add')) process.exit(2);",
      "if (!report.includes('Edge case')) process.exit(3);",
      "process.stdout.write('module=' + moduleDir + ';api=add;report=edge-case;token=SHOULD_NOT_LEAK');"
    ].join("\n") + "\n",
    "utf8"
  );
  return { moduleDir, verifierCommand: `node ${JSON.stringify(verifierPath)}`, reportPath };
}

async function writePlan(dir: string, name: string, workflowPlan: WorkflowPlan): Promise<string> {
  const planPath = path.join(dir, name);
  await writeFile(planPath, `${JSON.stringify(workflowPlan, null, 2)}\n`, "utf8");
  return planPath;
}

async function runCliLifecycle(planPath: string, rootDir: string): Promise<{ runId: string; runDir: string; summary: string }> {
  await execFileAsync("node", [binPath, "validate", planPath]);
  const compiled = await execFileAsync("node", [binPath, "compile", planPath]);
  assert.match(compiled.stdout, /dynamic_workflow\/compiled\/v2/, "compile output should be manifest v2");
  const run = await execFileAsync("node", [binPath, "run", planPath, "--root", rootDir]);
  assert.match(run.stdout, /DW_RUN_COMPLETE/, "CLI workflow should complete");
  const runId = run.stdout.match(/DW_RUN_START (\S+)/)?.[1];
  assert.ok(runId, "run output should contain run id");
  const status = await execFileAsync("node", [binPath, "status", runId, "--root", rootDir]);
  assert.match(status.stdout, /state=completed/, "status should report completed workflow");
  const review = await execFileAsync("node", [binPath, "review", runId, "--root", rootDir]);
  assert.match(review.stdout, /"ok": true/, "review should be ok");
  const summary = await execFileAsync("node", [binPath, "summarize", runId, "--root", rootDir]);
  const resume = await execFileAsync("node", [binPath, "resume", runId, "--root", rootDir]);
  assert.match(resume.stdout, /reused_succeeded=/, "resume should report reused succeeded steps");
  return { runId, runDir: path.join(rootDir, "runs", runId), summary: summary.stdout };
}

test("workflow mode matrix names every registered mode and validation surface", async () => {
  const matrix = await readFile(MATRIX_PATH, "utf8");
  for (const stepType of Object.keys(STEP_REGISTRY)) {
    assert.match(matrix, new RegExp(`\\\`${stepType.replace(".", "\\.")}\\\``), `matrix should list ${stepType}`);
  }
  for (const requiredSurface of [
    "Sequential Dataflow Module Review",
    "Fan-Out Generate/Review/Filter/Synthesize",
    "Conditional Include Feature/Bugfix",
    "Loop Body + Previous Feedback + Until",
    "Tournament Chain",
    "Human Gate + Failure/Resume",
    "JS-First Harness Capture"
  ]) {
    assert.match(matrix, new RegExp(requiredSurface.replace(/[+/]/g, "\\$&")), `matrix should include ${requiredSurface}`);
  }
});

test("CLI sequential dataflow validates temp module and summarizes sanitized context sources", async () => {
  const { verifierCommand } = await createTempModule();
  const dir = await tempRoot("dw-mode-cli-");
  const rootDir = path.join(dir, "runtime");
  const planPath = await writePlan(
    dir,
    "sequential.json",
    plan("dwf_mode_sequential", [
      {
        step_id: "verify_module",
        type: "command.verify",
        depends_on: [],
        verify: { commands: [verifierCommand] },
        produces: { checks: { select: "$.verify.checks", schema: "command_checks/v1" } }
      },
      {
        step_id: "review_module",
        type: "agent.review",
        depends_on: ["verify_module"],
        input: { prompt: "Review module verifier output" },
        consumes: [{ from: "verify_module", select: "$.verify.checks[*].stdout", as: "module_report" }]
      },
      {
        step_id: "synthesize_module",
        type: "agent.synthesize",
        depends_on: ["review_module"],
        input: { prompt: "Summarize module readiness" },
        consumes: [{ from: "review_module", select: "$.output.context.module_report", as: "review_context", max_bytes: 80 }]
      }
    ])
  );

  const { runDir, summary } = await runCliLifecycle(planPath, rootDir);
  const reviewArtifact = await readJson<JsonObject>(path.join(runDir, "steps", "review_module.json"));
  assert.match(JSON.stringify(reviewArtifact.output), /module=.*api=add/, "review should consume verifier stdout");
  assert.match(summary, /"context_sources"/, "summary should include context source metadata");
  assert.match(summary, /"alias": "module_report"/, "summary should include module_report alias");
  assert.doesNotMatch(summary, /SHOULD_NOT_LEAK/, "summary should not include raw context payload");
  assert.doesNotMatch(summary, /Review module verifier output/, "summary should not include raw prompt text");
});

test("runtime covers fan-out, generate/filter/judge, include, loop, tournament, run_if, and control dataflow rewrites", async () => {
  const { verifierCommand } = await createTempModule();
  const rootDir = await tempRoot("dw-mode-runtime-");
  const workflowPlan = plan("dwf_mode_matrix_runtime", [
    { step_id: "classify", type: "agent.classify", depends_on: [], input: { label: "feature" } },
    { step_id: "candidate_a", type: "agent.generate", depends_on: [], input: { resource_scope: "candidate_a" } },
    { step_id: "candidate_b", type: "agent.generate", depends_on: [], input: { resource_scope: "candidate_b" } },
    { step_id: "candidate_c", type: "agent.generate", depends_on: [], input: { resource_scope: "candidate_c" } },
    {
      step_id: "filter_candidates",
      type: "agent.filter",
      depends_on: ["candidate_a", "candidate_b", "candidate_c"],
      consumes: [
        { from: "candidate_a", select: "$.output.candidates[*].id", as: "candidate_a_ids" },
        { from: "candidate_b", select: "$.output.candidates[*].id", as: "candidate_b_ids" },
        { from: "candidate_c", select: "$.output.candidates[*].id", as: "candidate_c_ids" }
      ],
      input: { accepted: ["candidate_a_candidate", "candidate_b_candidate"], rejected: ["candidate_c_candidate"] }
    },
    {
      step_id: "direct_judge",
      type: "agent.judge_pair",
      depends_on: ["candidate_a", "candidate_b"],
      input: { candidate_a: "candidate_a", candidate_b: "candidate_b", criteria: ["maintainability"] }
    },
    {
      step_id: "feature_flow",
      type: "workflow.include",
      depends_on: ["classify"],
      input: { workflow_ref: "builtin.feature" },
      run_if: { step: "classify", output_path: "label", op: "==", value: "feature" }
    },
    {
      step_id: "control_consumer",
      type: "agent.synthesize",
      depends_on: ["feature_flow"],
      consumes: [{ from: "feature_flow", select: "$.output.ok", as: "feature_review_ok" }]
    },
    {
      step_id: "design_tournament",
      type: "workflow.tournament",
      depends_on: ["filter_candidates", "direct_judge", "control_consumer", "candidate_a", "candidate_b", "candidate_c"],
      input: {
        candidate_steps: ["candidate_a", "candidate_b", "candidate_c"],
        criteria: ["correctness", "risk", "maintainability"]
      }
    },
    {
      step_id: "repair_loop",
      type: "workflow.loop",
      depends_on: ["design_tournament"],
      input: {
        max_rounds: 3,
        stop_condition: "module_verified",
        until: { output_path: "blocking_count", op: "==", value: 0 },
        body: [
          {
            step_id: "execute",
            type: "agent.execute",
            depends_on: [],
            input: { output: { artifacts: [{ path: "src/math.ts", kind: "file", status: "checked" }] } },
            consumes: [
              { from: "design_tournament", select: "$.output.winner", as: "winner" },
              { from: "$previous", select: "$.output.findings", as: "previous_findings", required: false }
            ]
          },
          {
            step_id: "collect_tests",
            type: "command.collect",
            depends_on: ["execute"],
            collect: { commands: [{ id: "module_probe", run: verifierCommand, allow_exit_codes: [0, 1], soft_fail: true }] }
          },
          {
            step_id: "review",
            type: "agent.review",
            depends_on: ["collect_tests"],
            input: { output: { ok: true, findings: [], blocking_count: 0 } },
            consumes: [{ from: "collect_tests", select: "$.output.collection.checks", as: "verification" }]
          }
        ]
      }
    },
    {
      step_id: "final_synthesis",
      type: "agent.synthesize",
      depends_on: ["repair_loop", "control_consumer"],
      consumes: [
        { from: "repair_loop", select: "$.output.blocking_count", as: "repair_blocking_count" },
        { from: "control_consumer", select: "$.output.summary", as: "included_summary" },
        { from: "design_tournament", select: "$.output.winner", as: "tournament_winner" },
        { from: "filter_candidates", select: "$.output.accepted", as: "accepted_candidates" },
        { from: "direct_judge", select: "$.output.rationale", as: "direct_judge_rationale" }
      ]
    },
    {
      step_id: "verify_final",
      type: "command.verify",
      depends_on: ["final_synthesis"],
      verify: { commands: [verifierCommand] }
    }
  ]);

  const compiled = compilePlan(workflowPlan);
  assert.deepEqual(compiled.nodes.find((node) => node.step_id === "feature_flow__implement")?.run_if, {
    step: "classify",
    output_path: "label",
    op: "==",
    value: "feature"
  });
  assert.deepEqual(compiled.nodes.find((node) => node.step_id === "final_synthesis")?.consumes, [
    { from: "repair_loop__round_3__review", select: "$.output.blocking_count", as: "repair_blocking_count" },
    { from: "control_consumer", select: "$.output.summary", as: "included_summary" },
    { from: "design_tournament__judge_2", select: "$.output.winner", as: "tournament_winner" },
    { from: "filter_candidates", select: "$.output.accepted", as: "accepted_candidates" },
    { from: "direct_judge", select: "$.output.rationale", as: "direct_judge_rationale" }
  ]);

  const result = await runWorkflow(workflowPlan, { rootDir, runId: "run_mode_matrix_runtime" });
  assert.equal(result.record.state, "completed", "runtime matrix workflow should complete");
  assert.ok(result.markers.includes("DW_RUN_COMPLETE"), "runtime matrix should emit DW_RUN_COMPLETE");
  assert.equal(result.record.steps.feature_flow__implement?.state, "succeeded", "run_if true include branch should execute implement");
  assert.equal(result.record.steps.feature_flow__review?.state, "succeeded", "run_if true include branch should execute review");
  assert.deepEqual(result.manifest.dependencies.control_consumer, ["feature_flow__review"], "include dependency should rewrite to terminal node");
  assert.deepEqual(result.manifest.nodes.find((node) => node.step_id === "control_consumer")?.consumes, [
    { from: "feature_flow__review", select: "$.output.ok", as: "feature_review_ok" }
  ]);
  assert.deepEqual(result.manifest.dependencies.repair_loop__round_1__execute, ["design_tournament__judge_2"], "loop body entry should depend on tournament terminal judge");
  assert.deepEqual(result.manifest.dependencies.repair_loop__round_2__execute, ["repair_loop__round_1__review"], "second loop round should depend on previous review");
  assert.deepEqual(result.manifest.dependencies.final_synthesis, ["control_consumer", "repair_loop__round_3__review"], "synthesis should depend on loop terminal review");
  assert.equal(result.record.steps.design_tournament__judge_1?.state, "succeeded", "first tournament judge should run");
  assert.equal(result.record.steps.design_tournament__judge_2?.state, "succeeded", "terminal tournament judge should run");
  assert.equal(result.record.steps.repair_loop__round_1__execute?.state, "succeeded", "first loop execute should run");
  assert.equal(result.record.steps.repair_loop__round_1__collect_tests?.state, "succeeded", "first loop collection should run");
  assert.equal(result.record.steps.repair_loop__round_1__review?.state, "succeeded", "first loop review should run");
  assert.equal(result.record.steps.repair_loop__round_2__execute?.state, "skipped", "until should skip second loop execute");
  assert.equal(result.record.steps.repair_loop__round_3__review?.state, "skipped", "until should skip terminal third review");
  const classifyArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "classify.json"));
  assert.equal(classifyArtifact.output?.["label"], "feature", "classify should expose label");
  assert.equal(classifyArtifact.output?.["confidence"], 1, "classify should expose confidence");
  const reviewArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "feature_flow__review.json"));
  assert.equal(reviewArtifact.output?.["ok"], true, "review should expose ok");
  assert.deepEqual(reviewArtifact.output?.["findings"], [], "review should expose findings");
  assert.equal(reviewArtifact.output?.["blocking_count"], 0, "review should expose blocking_count");
  const candidateArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "candidate_a.json"));
  assert.ok(Array.isArray(candidateArtifact.output?.["candidates"]), "generate should expose candidates");
  const filterArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "filter_candidates.json"));
  assert.deepEqual(filterArtifact.output?.["accepted"], ["candidate_a_candidate", "candidate_b_candidate"], "filter should expose accepted");
  assert.deepEqual(filterArtifact.output?.["rejected"], ["candidate_c_candidate"], "filter should expose rejected");
  assert.match(JSON.stringify(filterArtifact.output), /candidate_a_ids/, "filter should consume generated candidate ids");
  const judgeArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "design_tournament__judge_2.json"));
  assert.equal(judgeArtifact.output?.["winner"], "design_tournament__judge_1", "tournament judge should expose winner");
  assert.equal(judgeArtifact.output?.["loser"], "candidate_c", "tournament judge should expose loser");
  assert.match(String(judgeArtifact.output?.["rationale"]), /selected/, "tournament judge should expose rationale");
  const repairArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "repair_loop__round_3__review.json"));
  assert.equal(repairArtifact.output?.["blocking_count"], 0, "skipped loop terminal should forward blocking count");
  const finalArtifact = await readJson<StepArtifact>(path.join(result.record.run_dir, "steps", "final_synthesis.json"));
  assert.match(String(finalArtifact.output?.["summary"]), /Executed final_synthesis/, "synthesize should expose summary");
  assert.deepEqual(finalArtifact.output?.["decisions"], [], "synthesize should expose decisions");
  assert.deepEqual(finalArtifact.output?.["next_actions"], [], "synthesize should expose next_actions");
  assert.match(JSON.stringify(finalArtifact.output), /repair_blocking_count/, "final synthesis should consume loop terminal review output");
  assert.match(JSON.stringify(finalArtifact.output), /tournament_winner/, "final synthesis should consume tournament winner");
  assert.match(JSON.stringify(finalArtifact.output), /accepted_candidates/, "final synthesis should consume filter output");
});

test("include bugfix flow and run_if false branch compile into expected skipped control nodes", async () => {
  const rootDir = await tempRoot("dw-mode-bugfix-include-");
  const result = await runWorkflow(
    plan("dwf_mode_bugfix_include", [
      { step_id: "classify", type: "agent.classify", depends_on: [] },
      {
        step_id: "bugfix_flow",
        type: "workflow.include",
        depends_on: ["classify"],
        input: { workflow_ref: "builtin.bugfix" },
        run_if: { step: "classify", output_path: "status", op: "!=", value: "succeeded" }
      },
      {
        step_id: "summary",
        type: "agent.synthesize",
        depends_on: ["bugfix_flow"],
        input: { resource_scope: "bugfix_summary" }
      }
    ]),
    { rootDir, runId: "run_mode_bugfix_include" }
  );
  assert.equal(result.record.state, "completed", "bugfix include run should complete with skipped branch");
  assert.ok(result.markers.includes("DW_RUN_COMPLETE"), "bugfix include run should emit completion marker");
  assert.deepEqual(result.manifest.dependencies.summary, ["bugfix_flow__fix"], "bugfix include dependency should rewrite to terminal fix node");
  assert.equal(result.record.steps.bugfix_flow__diagnose?.state, "skipped", "run_if false bugfix diagnose should skip");
  assert.equal(result.record.steps.bugfix_flow__fix?.state, "skipped", "run_if false bugfix fix should skip");
  assert.equal(result.record.steps.summary?.state, "succeeded", "downstream summary should proceed after skipped include branch");
});

test("human approval waits and failed steps block downstream while resume reports reused artifacts", async () => {
  const rootDir = await tempRoot("dw-mode-wait-fail-");
  const waiting = await runWorkflow(
    plan("dwf_mode_human_wait", [
      { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
      { step_id: "approval", type: "human.approval", depends_on: ["collect"] },
      { step_id: "after_approval", type: "agent.execute", depends_on: ["approval"] }
    ]),
    { rootDir, runId: "run_mode_human_wait" }
  );
  assert.equal(waiting.record.state, "waiting_user", "human approval workflow should enter waiting_user");
  assert.equal(waiting.record.steps.approval?.state, "waiting_user", "approval step should wait for user");
  assert.equal(waiting.record.steps.after_approval?.state, "queued", "downstream should remain queued while approval waits");
  assert.equal(waiting.markers.includes("DW_RUN_COMPLETE"), false, "waiting workflow should not emit completion marker");
  const trace = await readFile(path.join(waiting.record.run_dir, "trace.jsonl"), "utf8");
  assert.match(trace, /step_waiting_user/, "trace should record waiting user event");

  const failed = await runWorkflow(
    plan("dwf_mode_failure_resume", [
      { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
      { step_id: "fail", type: "agent.execute", depends_on: ["collect"], input: { force_fail: true } },
      { step_id: "blocked_review", type: "agent.review", depends_on: ["fail"] }
    ]),
    { rootDir, runId: "run_mode_failure_resume" }
  );
  assert.equal(failed.record.state, "failed", "force failed workflow should fail");
  assert.equal(failed.record.steps.collect?.state, "succeeded", "upstream verifier should be reusable");
  assert.equal(failed.record.steps.blocked_review?.state, "blocked", "downstream review should be blocked");
  const resume = await execFileAsync("node", [binPath, "resume", "run_mode_failure_resume", "--root", rootDir]).catch((error: unknown) => {
    const failedResume = error as { stdout?: string };
    return { stdout: failedResume.stdout ?? "" };
  });
  assert.match(resume.stdout, /reused_succeeded=1/, "resume should report one reusable succeeded artifact");
  assert.match(resume.stdout, /state=failed/, "resume should preserve failed run state");
});

test("JS harness captures all declarative primitives and rejects unsafe execution", () => {
  const source = `
const docs = command("collect_docs", { run: ["printf docs"] })
const implementation = agent.execute("implement_module", {
  prompt: "Implement module from docs",
  context: {
    docs: docs.output("$.output.collection.checks[*].stdout")
  }
})
const review = agent.review("review_module", {
  prompt: "Review implementation",
  context: {
    implementation: implementation.output("$.output.status")
  }
})
agent.synthesize("summarize_module", {
  prompt: "Summarize module",
  context: {
    docs: docs.output("$.output.collection.checks[*].stdout"),
    review: review.output("$.output.status")
  }
})
`;
  const result = compileHarnessToPlan(source, "dwf_mode_harness");
  assert.deepEqual(
    result.plan.steps.map((step) => step.type),
    ["command.collect", "agent.execute", "agent.review", "agent.synthesize"]
  );
  assert.deepEqual(result.manifest.dependencies.implement_module, ["collect_docs"]);
  assert.deepEqual(result.manifest.dependencies.review_module, ["implement_module"]);
  assert.deepEqual(result.manifest.dependencies.summarize_module, ["collect_docs", "review_module"]);
  assert.deepEqual(result.manifest.nodes.find((node) => node.step_id === "summarize_module")?.consumes, [
    { from: "collect_docs", select: "$.output.collection.checks[*].stdout", as: "docs" },
    { from: "review_module", select: "$.output.status", as: "review" }
  ]);
  assert.throws(() => compileHarnessToPlan("process.env.SECRET"), /Harness denied capability/);
});
