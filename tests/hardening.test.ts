import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { validatePlan } from "../src/index.js";
import { runWorkflow } from "../src/runtime.js";
import type { WorkflowPlan } from "../src/index.js";

const execFileAsync = promisify(execFile);
const binPath = path.resolve("bin/dw.mjs");
const skillDir = path.resolve("skills/dynamic-workflow");

test("edge validation covers empty plan, invalid yaml, invalid json, duplicate ids, cycles, missing deps, unsupported profile and backend", async () => {
  assert.equal(validatePlan({ schema_version: "dynamic_workflow/run/v1", workflow_id: "empty", steps: [] }).ok, false);
  const dir = await mkdtemp(path.join(os.tmpdir(), "dw-hardening-"));
  const invalidYaml = path.join(dir, "invalid.yaml");
  await writeFile(invalidYaml, "schema_version: [", "utf8");
  await assert.rejects(execFileAsync("node", [binPath, "validate", invalidYaml]));
  const invalidJson = path.join(dir, "invalid.json");
  await writeFile(invalidJson, "{", "utf8");
  await assert.rejects(execFileAsync("node", [binPath, "validate", invalidJson]));
  const cases: Array<[unknown, string]> = [
    [
      {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "duplicate",
        steps: [
          { step_id: "x", type: "agent.review", depends_on: [] },
          { step_id: "x", type: "agent.review", depends_on: [] }
        ]
      },
      "duplicate_step_id"
    ],
    [
      {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "cycle",
        steps: [
          { step_id: "a", type: "agent.review", depends_on: ["b"] },
          { step_id: "b", type: "agent.review", depends_on: ["a"] }
        ]
      },
      "dependency_cycle"
    ],
    [
      {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "missing",
        steps: [{ step_id: "a", type: "agent.review", depends_on: ["z"] }]
      },
      "unknown_dependency"
    ],
    [
      {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "profile",
        steps: [{ step_id: "a", type: "agent.review", permission_profile: "root", depends_on: [] }]
      },
      "unsupported_permission_profile"
    ],
    [
      {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "backend",
        steps: [{ step_id: "a", type: "agent.review", backend: "acp", depends_on: [] }]
      },
      "unsupported_backend"
    ],
    [
      {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: "verify",
        steps: [{ step_id: "verify", type: "command.verify", depends_on: [] }]
      },
      "missing_verify_commands"
    ]
  ];
  for (const [plan, code] of cases) {
    const result = validatePlan(plan);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === code));
  }
});

test("run_if false skips dependent step and downstream can proceed", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "dw-run-if-"));
  const plan: WorkflowPlan = {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: "dwf_run_if_skip",
    kind: "mixed",
    steps: [
      { step_id: "review", type: "agent.review", depends_on: [] },
      {
        step_id: "fix",
        type: "agent.execute",
        depends_on: ["review"],
        run_if: { step: "review", output_path: "blocking_count", op: ">", value: 0 }
      },
      { step_id: "summarize", type: "agent.synthesize", depends_on: ["fix"] }
    ]
  };
  const result = await runWorkflow(plan, { rootDir, runId: "run_if_skip" });
  assert.equal(result.record.steps.fix?.state, "skipped");
  assert.equal(result.record.steps.summarize?.state, "succeeded");
  assert.equal(result.audit.ok, true);
});

test("skill payload excludes runtime artifacts", async () => {
  const entries = await readdir(skillDir);
  assert.ok(entries.includes("SKILL.md"));
  assert.ok(!entries.includes(".dynamic-workflow"));
});

test("skill bundled plan template is the documented authoring base and validates", async () => {
  const templatePath = path.join(skillDir, "templates/plan.yaml");
  const skillText = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  assert.match(skillText, /<skill_dir>\/templates\/plan\.yaml/);
  assert.doesNotMatch(skillText, /based on `templates\/plan\.yaml`/);

  const valid = await execFileAsync("node", [binPath, "validate", templatePath]);
  assert.match(valid.stdout, /valid dwf_example steps=3/);

  const compiled = await execFileAsync("node", [binPath, "compile", templatePath]);
  assert.match(compiled.stdout, /"workflow_id": "dwf_example"/);
  assert.match(compiled.stdout, /"step_id": "classify"/);
});

test("skill dw wrapper resolves the repository runtime from the installed skill path", async () => {
  const wrapperPath = path.join(skillDir, "scripts/dw");
  const result = await execFileAsync(wrapperPath, ["validate", path.join(skillDir, "templates/plan.yaml")]);
  assert.match(result.stdout, /valid dwf_example steps=3/);

  const installRoot = await mkdtemp(path.join(os.tmpdir(), "dw-skill-install-"));
  const installedSkill = path.join(installRoot, "dynamic-workflow");
  await symlink(skillDir, installedSkill);
  const installedResult = await execFileAsync(path.join(installedSkill, "scripts/dw"), [
    "validate",
    path.join(installedSkill, "templates/plan.yaml")
  ]);
  assert.match(installedResult.stdout, /valid dwf_example steps=3/);
});
