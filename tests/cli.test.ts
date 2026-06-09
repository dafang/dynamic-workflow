import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const binPath = path.resolve("bin/dw.mjs");

async function fixturePlan(): Promise<{ dir: string; planPath: string; rootDir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dw-cli-"));
  const planPath = path.join(dir, "plan.yaml");
  const rootDir = path.join(dir, "runtime");
  await writeFile(
    planPath,
    `schema_version: dynamic_workflow/run/v1
workflow_id: dwf_cli_test
kind: mixed
steps:
  - step_id: execute
    type: agent.execute
    depends_on: []
  - step_id: verify
    type: command.verify
    depends_on: [execute]
    input:
      commands: ["node --version"]
`,
    "utf8"
  );
  return { dir, planPath, rootDir };
}

test("prints help", async () => {
  const { stdout } = await execFileAsync("node", [binPath, "--help"]);
  assert.match(stdout, /dw validate <plan>/);
  assert.match(stdout, /dw summarize <run-id>/);
});

test("validates and rejects plans", async () => {
  const { dir, planPath } = await fixturePlan();
  const valid = await execFileAsync("node", [binPath, "validate", planPath]);
  assert.match(valid.stdout, /valid dwf_cli_test steps=2/);
  const invalidPath = path.join(dir, "invalid.yaml");
  await writeFile(invalidPath, "schema_version: bad\nworkflow_id: bad\nsteps: []\n", "utf8");
  await assert.rejects(execFileAsync("node", [binPath, "validate", invalidPath]), /unsupported_schema_version/);
});

test("validate and compile surface plan warnings without blocking valid plans", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dw-cli-warnings-"));
  const planPath = path.join(dir, "warnings.yaml");
  await writeFile(
    planPath,
    `schema_version: dynamic_workflow/run/v1
workflow_id: dwf_cli_warnings
kind: mixed
steps:
  - step_id: verify_searches
    type: command.verify
    depends_on: []
    verify:
      commands:
        - rg --glob '*.py' 'class ' .
        - /bin/sh -c "rg optional_a ."
        - rg optional_b .
`,
    "utf8"
  );

  const valid = await execFileAsync("node", [binPath, "validate", planPath]);
  assert.match(valid.stdout, /valid dwf_cli_warnings steps=1/);
  assert.match(valid.stdout, /warning broad_rg_missing_excludes step=verify_searches/);
  assert.match(valid.stdout, /warning nested_shell step=verify_searches/);
  assert.match(valid.stdout, /warning verify_optional_searches step=verify_searches/);

  const compiled = await execFileAsync("node", [binPath, "compile", planPath]);
  assert.match(compiled.stdout, /"manifest_version": "dynamic_workflow\/compiled\/v2"/);
  assert.match(compiled.stderr, /warning broad_rg_missing_excludes step=verify_searches/);
});

test("compiles, runs, reports status, review, summary, and resume", async () => {
  const { planPath, rootDir } = await fixturePlan();
  const compiled = await execFileAsync("node", [binPath, "compile", planPath]);
  assert.match(compiled.stdout, /"manifest_version": "dynamic_workflow\/compiled\/v2"/);

  const run = await execFileAsync("node", [binPath, "run", planPath, "--root", rootDir]);
  assert.match(run.stdout, /DW_RUN_START/);
  assert.match(run.stdout, /DW_STEP_START execute/);
  assert.match(run.stdout, /DW_STEP_VERIFY verify succeeded/);
  assert.match(run.stdout, /DW_REVIEW_COMPLETE ok/);
  assert.match(run.stdout, /DW_RUN_COMPLETE/);
  const runId = run.stdout.match(/DW_RUN_START (\S+)/)?.[1];
  assert.ok(runId);

  const status = await execFileAsync("node", [binPath, "status", runId, "--root", rootDir]);
  assert.match(status.stdout, /state=completed/);
  assert.doesNotMatch(status.stdout, /prompt/);

  const review = await execFileAsync("node", [binPath, "review", runId, "--root", rootDir]);
  assert.match(review.stdout, /"ok": true/);

  const summary = await execFileAsync("node", [binPath, "summarize", runId, "--root", rootDir]);
  assert.match(summary.stdout, /"state": "completed"/);
  assert.doesNotMatch(summary.stdout, /raw_prompt|token|debug/);

  const resume = await execFileAsync("node", [binPath, "resume", runId, "--root", rootDir]);
  assert.match(resume.stdout, /reused_succeeded=2/);
});

test("dataflow plan completes full CLI lifecycle with sanitized context summary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dw-cli-dataflow-"));
  const planPath = path.join(dir, "dataflow.yaml");
  const rootDir = path.join(dir, "runtime");
  await writeFile(
    planPath,
    `schema_version: dynamic_workflow/run/v1
workflow_id: dwf_cli_dataflow
kind: mixed
steps:
  - step_id: collect
    type: command.verify
    depends_on: []
    verify:
      commands:
        - printf dataflow-docs
  - step_id: review
    type: agent.review
    depends_on: [collect]
    input:
      prompt: "Review raw_prompt token secret should stay out of summary"
    consumes:
      - from: collect
        select: $.verify.checks[*].stdout
        as: docs
  - step_id: synthesize
    type: agent.synthesize
    depends_on: [review]
    input:
      prompt: "Summarize findings"
    consumes:
      - from: review
        select: $.output.context.docs
        as: findings
        max_bytes: 8
`,
    "utf8"
  );

  const valid = await execFileAsync("node", [binPath, "validate", planPath]);
  assert.match(valid.stdout, /valid dwf_cli_dataflow steps=3/);

  const compiled = await execFileAsync("node", [binPath, "compile", planPath]);
  assert.match(compiled.stdout, /"manifest_version": "dynamic_workflow\/compiled\/v2"/);
  assert.match(compiled.stdout, /"consumes"/);
  assert.match(compiled.stdout, /"as": "docs"/);

  const run = await execFileAsync("node", [binPath, "run", planPath, "--root", rootDir]);
  assert.match(run.stdout, /DW_RUN_COMPLETE/);
  assert.match(run.stdout, /DW_STEP_VERIFY synthesize succeeded/);
  const runId = run.stdout.match(/DW_RUN_START (\S+)/)?.[1];
  assert.ok(runId);

  const status = await execFileAsync("node", [binPath, "status", runId, "--root", rootDir]);
  assert.match(status.stdout, /state=completed/);
  assert.match(status.stdout, /step synthesize state=succeeded/);

  const review = await execFileAsync("node", [binPath, "review", runId, "--root", rootDir]);
  assert.match(review.stdout, /"ok": true/);

  const summary = await execFileAsync("node", [binPath, "summarize", runId, "--root", rootDir]);
  assert.match(summary.stdout, /"context_sources"/);
  assert.match(summary.stdout, /"alias": "docs"/);
  assert.match(summary.stdout, /"alias": "findings"/);
  assert.match(summary.stdout, /"clipped": true/);
  assert.doesNotMatch(summary.stdout, /dataflow-docs/);
  assert.doesNotMatch(summary.stdout, /raw_prompt|token|secret/);

  const resume = await execFileAsync("node", [binPath, "resume", runId, "--root", rootDir]);
  assert.match(resume.stdout, /reused_succeeded=3/);
  assert.match(resume.stdout, /state=completed/);
});

test("command.collect CLI workflow continues with partial evidence and summarizes gaps without raw output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dw-cli-collect-"));
  const planPath = path.join(dir, "collect.yaml");
  const rootDir = path.join(dir, "runtime");
  await writeFile(
    planPath,
    `schema_version: dynamic_workflow/run/v1
workflow_id: dwf_cli_collect
kind: mixed
steps:
  - step_id: collect
    type: command.collect
    permission_profile: command_collector
    depends_on: []
    collect:
      commands:
        - id: docs
          run: printf SHOULD_NOT_LEAK_COLLECTED_DOCS
        - id: miss
          run: tmp=$(mktemp -d); printf haystack > "$tmp/file.txt"; rg __dynamic_workflow_no_match__ "$tmp/file.txt"
          allow_exit_codes: [0]
          soft_fail: true
  - step_id: synthesize
    type: agent.synthesize
    depends_on: [collect]
    consumes:
      - from: collect
        select: $.output.collection.checks[*].stdout
        as: collected
`,
    "utf8"
  );

  const valid = await execFileAsync("node", [binPath, "validate", planPath]);
  assert.match(valid.stdout, /valid dwf_cli_collect steps=2/);

  const run = await execFileAsync("node", [binPath, "run", planPath, "--root", rootDir]);
  assert.match(run.stdout, /DW_RUN_COMPLETE/);
  const runId = run.stdout.match(/DW_RUN_START (\S+)/)?.[1];
  assert.ok(runId);

  const summary = await execFileAsync("node", [binPath, "summarize", runId, "--root", rootDir]);
  assert.match(summary.stdout, /"collection_gaps"/);
  assert.match(summary.stdout, /"id": "miss"/);
  assert.match(summary.stdout, /"failure_category": "no_match"/);
  assert.doesNotMatch(summary.stdout, /SHOULD_NOT_LEAK_COLLECTED_DOCS/);
});

test("run returns non-zero on failed step", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dw-cli-fail-"));
  const planPath = path.join(dir, "fail.yaml");
  await writeFile(
    planPath,
    `schema_version: dynamic_workflow/run/v1
workflow_id: dwf_cli_fail
kind: mixed
steps:
  - step_id: fail
    type: agent.execute
    depends_on: []
    input:
      force_fail: true
`,
    "utf8"
  );
  await assert.rejects(
    execFileAsync("node", [binPath, "run", planPath, "--root", path.join(dir, "runtime")]),
    (error: unknown) => {
      const failed = error as { stdout?: string };
      assert.match(failed.stdout ?? "", /DW_STEP_VERIFY fail failed/);
      return true;
    }
  );
});
