import assert from "node:assert/strict";
import test from "node:test";

import { lintPlan, validatePlan } from "../src/index.js";
import type { WorkflowPlan } from "../src/index.js";

function plan(steps: WorkflowPlan["steps"]): WorkflowPlan {
  return {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: "dwf_lint_test",
    kind: "mixed",
    steps
  };
}

test("lintPlan warns on broad rg scans, nested shell, optional verify probes, and oversized command groups", () => {
  const result = validatePlan(
    plan([
      {
        step_id: "verify_searches",
        type: "command.verify",
        depends_on: [],
        verify: {
          commands: [
            "rg --glob '*.py' 'class ' .",
            "/bin/sh -c \"rg optional_a .\"",
            "rg optional_b .",
            "ls optional",
            "find . -name '*.ts'",
            "grep -R needle ."
          ]
        }
      }
    ])
  );
  assert.equal(result.ok, true);
  const warnings = lintPlan(result.plan);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["broad_rg_missing_excludes", "nested_shell", "verify_optional_searches", "oversized_command_group"]
  );
  assert.equal(warnings[0]?.step_id, "verify_searches");
  assert.match(warnings[0]?.message ?? "", /.venv/);
  assert.match(warnings[0]?.message ?? "", /.dynamic-workflow/);
  assert.match(warnings[0]?.message ?? "", /__pycache__/);
});

test("lintPlan does not warn for bounded command.collect scans", () => {
  const result = validatePlan(
    plan([
      {
        step_id: "collect",
        type: "command.collect",
        permission_profile: "command_collector",
        depends_on: [],
        collect: {
          commands: [
            {
              run: "rg --glob '*.py' --glob '!{.venv,.dynamic-workflow,__pycache__}/**' 'class ' .",
              allow_exit_codes: [0, 1],
              soft_fail: true
            }
          ]
        }
      }
    ])
  );
  assert.equal(result.ok, true);
  assert.deepEqual(lintPlan(result.plan), []);
});

test("lintPlan warns when agent steps would use the current backend stub", () => {
  const result = validatePlan(
    plan([
      {
        step_id: "review",
        type: "agent.review",
        depends_on: []
      },
      {
        step_id: "synthesize",
        type: "agent.synthesize",
        depends_on: ["review"],
        input: { agent_backend: "paseo" }
      },
      {
        step_id: "loop",
        type: "workflow.loop",
        depends_on: ["synthesize"],
        input: {
          max_rounds: 2,
          stop_condition: "no_blockers",
          body: [
            {
              step_id: "execute",
              type: "agent.execute",
              depends_on: [],
              input: { agent_backend: "paseo" }
            },
            {
              step_id: "review_body",
              type: "agent.review",
              depends_on: ["execute"]
            }
          ]
        }
      }
    ])
  );
  assert.equal(result.ok, true);

  const warnings = lintPlan(result.plan);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["agent_current_stub", "agent_current_stub"]
  );
  assert.equal(warnings[0]?.step_id, "review");
  assert.equal(warnings[0]?.path, "steps[0].input.agent_backend");
  assert.match(warnings[0]?.message ?? "", /input\.agent_backend: paseo/);
  assert.equal(warnings[1]?.step_id, "review_body");
  assert.equal(warnings[1]?.path, "steps[2].input.body[1].input.agent_backend");
});
