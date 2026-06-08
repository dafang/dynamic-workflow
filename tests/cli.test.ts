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

test("compiles, runs, reports status, review, summary, and resume", async () => {
  const { planPath, rootDir } = await fixturePlan();
  const compiled = await execFileAsync("node", [binPath, "compile", planPath]);
  assert.match(compiled.stdout, /"manifest_version": "dynamic_workflow\/compiled\/v1"/);

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
