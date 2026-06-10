import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGENT_OUTPUT_CONTRACTS,
  AGENT_STEP_TYPES,
  SUPPORTED_JSON_SCHEMA_KEYWORDS,
  buildAgentOutputInstructions,
  listPermissionProfiles,
  listStepTypes,
  validatePlan
} from "../src/index.js";
import type { WorkflowPlan } from "../src/index.js";

function validPlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: "dwf_validation_test",
    kind: "mixed",
    budget: {
      max_steps: 20,
      max_subagents: 8,
      max_rounds: 3
    },
    steps: [
      {
        step_id: "classify",
        type: "agent.classify",
        permission_profile: "classifier",
        input: { prompt: "Classify request" },
        depends_on: []
      },
      {
        step_id: "review",
        type: "agent.review",
        permission_profile: "reviewer_readonly",
        input: { prompt: "Review output" },
        depends_on: ["classify"]
      }
    ],
    ...overrides
  };
}

function expectError(plan: unknown, code: string): void {
  const result = validatePlan(plan);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result.errors));
}

test("validates a canonical plan", () => {
  const result = validatePlan(validPlan({ backend: "current" }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps.length, 2);
});

test("agent output contracts cover every agent type with stable fields and JSON instructions", () => {
  assert.deepEqual([...AGENT_STEP_TYPES].sort(), [
    "agent.classify",
    "agent.execute",
    "agent.filter",
    "agent.generate",
    "agent.judge_pair",
    "agent.review",
    "agent.synthesize"
  ]);
  assert.deepEqual(Object.keys(AGENT_OUTPUT_CONTRACTS).sort(), [...AGENT_STEP_TYPES].sort());
  assert.deepEqual(AGENT_OUTPUT_CONTRACTS["agent.classify"].stableFields, ["label", "confidence", "metadata"]);
  assert.ok(AGENT_OUTPUT_CONTRACTS["agent.review"].stableFields.includes("blocking_count"));
  assert.ok(AGENT_OUTPUT_CONTRACTS["agent.synthesize"].stableFields.includes("next_actions"));
  assert.ok(AGENT_OUTPUT_CONTRACTS["agent.generate"].stableFields.includes("candidates"));
  assert.ok(AGENT_OUTPUT_CONTRACTS["agent.filter"].stableFields.includes("accepted"));
  assert.ok(AGENT_OUTPUT_CONTRACTS["agent.judge_pair"].stableFields.includes("winner"));
  assert.ok(AGENT_OUTPUT_CONTRACTS["agent.execute"].stableFields.includes("artifacts"));
  assert.ok(SUPPORTED_JSON_SCHEMA_KEYWORDS.includes("additionalProperties"));
  const instructions = buildAgentOutputInstructions("agent.review", {
    type: "object",
    required: ["risk_area"],
    properties: { risk_area: { type: "string" } },
    additionalProperties: true
  });
  assert.match(instructions, /Return a single JSON object/);
  assert.match(instructions, /blocking_count/);
  assert.match(instructions, /risk_area/);
});

test("normalizes docs sample style plan.steps", () => {
  const plan = validPlan();
  const result = validatePlan({
    schema_version: plan.schema_version,
    workflow_id: plan.workflow_id,
    kind: plan.kind,
    plan: {
      steps: plan.steps
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0]?.step_id, "classify");
});

test("rejects unsupported schema versions", () => {
  expectError(validPlan({ schema_version: "dynamic_workflow/run/v0" as "dynamic_workflow/run/v1" }), "unsupported_schema_version");
});

test("rejects duplicate step ids", () => {
  const plan = validPlan();
  expectError({ ...plan, steps: [plan.steps[0], plan.steps[0]] }, "duplicate_step_id");
});

test("rejects missing dependencies and run_if references", () => {
  const plan = validPlan({
    steps: [
      {
        step_id: "fix",
        type: "agent.execute",
        depends_on: ["missing"],
        run_if: { step: "other_missing", output_path: "blocking.length", op: ">", value: 0 }
      }
    ]
  });
  expectError(plan, "unknown_dependency");
  expectError(plan, "unknown_run_if_step");
});

test("validates dataflow consumes and produces", () => {
  const result = validatePlan(
    validPlan({
      steps: [
        {
          step_id: "collect",
          type: "command.verify",
          depends_on: [],
          verify: { commands: ["node --version"] },
          produces: {
            checks: { select: "$.verify.checks", schema: "command_checks/v1" }
          }
        },
        {
          step_id: "review",
          type: "agent.review",
          permission_profile: "reviewer_readonly",
          input: { prompt: "Review command output" },
          depends_on: ["collect"],
          consumes: [{ from: "collect", select: "$.verify.checks[*].stdout", as: "docs", required: true, max_bytes: 20_000 }]
        }
      ]
    })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.steps[1]?.consumes, [
    { from: "collect", select: "$.verify.checks[*].stdout", as: "docs", required: true, max_bytes: 20_000 }
  ]);
  assert.equal(result.plan.steps[0]?.produces?.checks?.schema, "command_checks/v1");
});

test("validates command.collect command objects with collector permission profile", () => {
  const result = validatePlan(
    validPlan({
      steps: [
        {
          step_id: "collect",
          type: "command.collect",
          permission_profile: "command_collector",
          depends_on: [],
          collect: {
            commands: [
              {
                id: "search",
                run: "rg needle .",
                allow_exit_codes: [0, 1],
                soft_fail: true,
                timeout_seconds: 5,
                stdout_max_bytes: 1000,
                stderr_max_bytes: 500
              }
            ]
          },
          produces: {
            checks: { select: "$.output.collection.checks", schema: "command_collection/v1" }
          }
        }
      ]
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0]?.permission_profile, "command_collector");
  assert.equal(result.plan.steps[0]?.type, "command.collect");
  assert.deepEqual(result.plan.steps[0]?.collect?.commands, [
    {
      id: "search",
      run: "rg needle .",
      allow_exit_codes: [0, 1],
      soft_fail: true,
      timeout_seconds: 5,
      stdout_max_bytes: 1000,
      stderr_max_bytes: 500
    }
  ]);
});

test("rejects invalid command.collect declarations", () => {
  expectError(
    validPlan({
      steps: [{ step_id: "collect", type: "command.collect", depends_on: [] }]
    }),
    "missing_collect_commands"
  );
  expectError(
    validPlan({
      steps: [
        {
          step_id: "collect",
          type: "command.collect",
          depends_on: [],
          collect: { commands: [{ run: "printf ok", allow_exit_codes: [300] }] }
        }
      ]
    }),
    "invalid_command_option"
  );
});

test("rejects invalid dataflow references and aliases", () => {
  expectError(
    validPlan({
      steps: [
        { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
        {
          step_id: "review",
          type: "agent.review",
          depends_on: ["collect"],
          consumes: [{ from: "missing", select: "$.verify.checks[*].stdout", as: "docs" }]
        }
      ]
    }),
    "unknown_consume_step"
  );
  expectError(
    validPlan({
      steps: [
        { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
        {
          step_id: "review",
          type: "agent.review",
          depends_on: ["collect"],
          consumes: [
            { from: "collect", select: "$.verify.checks[*].stdout", as: "docs" },
            { from: "collect", select: "$.output.status", as: "docs" }
          ]
        }
      ]
    }),
    "duplicate_consume_alias"
  );
  expectError(
    validPlan({
      steps: [
        { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
        {
          step_id: "review",
          type: "agent.review",
          depends_on: ["collect"],
          consumes: [{ from: "collect", select: "$.verify.checks[0].stdout", as: "docs" }]
        }
      ]
    }),
    "invalid_artifact_selector"
  );
  expectError(
    validPlan({
      steps: [
        { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
        {
          step_id: "review",
          type: "agent.review",
          depends_on: [],
          consumes: [{ from: "collect", select: "$.verify.checks[*].stdout", as: "docs" }]
        }
      ]
    }),
    "consume_not_upstream"
  );
  expectError(
    validPlan({
      steps: [
        { step_id: "collect", type: "command.verify", depends_on: [], verify: { commands: ["node --version"] } },
        {
          step_id: "review",
          type: "agent.review",
          depends_on: ["collect"],
          consumes: [{ from: "collect", select: "$.verify.checks[*].stdout", as: "docs", max_bytes: 2_000_000 }]
        }
      ]
    }),
    "max_bytes_exceeds_host_limit"
  );
});

test("rejects dependency cycles", () => {
  expectError(
    validPlan({
      steps: [
        { step_id: "a", type: "agent.review", depends_on: ["b"] },
        { step_id: "b", type: "agent.review", depends_on: ["a"] }
      ]
    }),
    "dependency_cycle"
  );
});

test("rejects unsupported step types and permission profiles", () => {
  expectError(
    validPlan({
      steps: [{ step_id: "shell", type: "shell.run" as "agent.execute", depends_on: [] }]
    }),
    "unsupported_step_type"
  );
  expectError(
    validPlan({
      steps: [{ step_id: "review", type: "agent.review", permission_profile: "writer" as "reviewer_readonly", depends_on: [] }]
    }),
    "unsupported_permission_profile"
  );
});

test("rejects explicit external backends", () => {
  expectError(validPlan({ backend: "codex" as "current" }), "unsupported_backend");
  expectError(
    validPlan({
      steps: [{ step_id: "run", type: "agent.execute", backend: "claude" as "current", depends_on: [] }]
    }),
    "unsupported_backend"
  );
});

test("rejects invalid workflow loops", () => {
  expectError(
    validPlan({
      steps: [{ step_id: "loop", type: "workflow.loop", input: { max_rounds: 3 }, depends_on: [] }]
    }),
    "invalid_loop"
  );
});

test("validates workflow loop body dataflow and previous-round feedback", () => {
  const result = validatePlan(
    validPlan({
      steps: [
        {
          step_id: "collect_context",
          type: "command.collect",
          depends_on: [],
          collect: { commands: ["node --version"] }
        },
        {
          step_id: "repair_loop",
          type: "workflow.loop",
          depends_on: ["collect_context"],
          input: {
            max_rounds: 3,
            stop_condition: "no_blockers",
            until: { output_path: "blocking_count", op: "==", value: 0 },
            body: [
              {
                step_id: "execute",
                type: "agent.execute",
                depends_on: [],
                consumes: [
                  { from: "collect_context", select: "$.output.collection.checks[*].stdout", as: "context" },
                  { from: "$previous", select: "$.output.findings", as: "previous_findings", required: false }
                ]
              },
              {
                step_id: "collect_tests",
                type: "command.collect",
                depends_on: ["execute"],
                collect: { commands: [{ id: "tests", run: "node --version", allow_exit_codes: [0, 1], soft_fail: true }] }
              },
              {
                step_id: "review",
                type: "agent.review",
                depends_on: ["collect_tests"],
                consumes: [{ from: "collect_tests", select: "$.output.collection.checks", as: "verification" }]
              }
            ]
          }
        }
      ]
    })
  );
  assert.equal(result.ok, true);
});

test("rejects invalid workflow loop body declarations", () => {
  expectError(
    validPlan({
      steps: [
        {
          step_id: "loop",
          type: "workflow.loop",
          depends_on: [],
          input: {
            max_rounds: 2,
            stop_condition: "done",
            body: [
              { step_id: "a", type: "agent.execute", depends_on: [] },
              { step_id: "b", type: "agent.review", depends_on: [] }
            ]
          }
        }
      ]
    }),
    "invalid_loop_body"
  );
  expectError(
    validPlan({
      steps: [
        {
          step_id: "loop",
          type: "workflow.loop",
          depends_on: [],
          input: {
            max_rounds: 2,
            stop_condition: "done",
            until: { output_path: "blocking_count", op: ">", value: 0 },
            body: [{ step_id: "review", type: "agent.review", depends_on: [] }]
          }
        }
      ]
    }),
    "invalid_loop_until"
  );
  expectError(
    validPlan({
      steps: [
        {
          step_id: "loop",
          type: "workflow.loop",
          depends_on: [],
          input: {
            max_rounds: 2,
            stop_condition: "done",
            body: [{ step_id: "review", type: "agent.review", depends_on: ["missing"] }]
          }
        }
      ]
    }),
    "unknown_loop_body_dependency"
  );
  expectError(
    validPlan({
      steps: [
        {
          step_id: "loop",
          type: "workflow.loop",
          depends_on: [],
          input: {
            max_rounds: 2,
            stop_condition: "done",
            body: [
              {
                step_id: "review",
                type: "agent.review",
                depends_on: [],
                consumes: [{ from: "missing", select: "$.output.status", as: "missing_context" }]
              }
            ]
          }
        }
      ]
    }),
    "unknown_loop_body_consume_step"
  );
  expectError(
    validPlan({
      steps: [
        {
          step_id: "loop",
          type: "workflow.loop",
          depends_on: [],
          input: {
            max_rounds: 2,
            stop_condition: "done",
            body: [
              {
                step_id: "review",
                type: "agent.review",
                depends_on: [],
                run_if: { step: "missing", output_path: "ok", op: "==", value: true }
              }
            ]
          }
        }
      ]
    }),
    "unknown_loop_body_run_if_step"
  );
});

test("rejects budgets exceeding host maximums", () => {
  expectError(validPlan({ budget: { max_steps: 9999 } }), "budget_exceeds_host_limit");
  expectError(
    validPlan({
      steps: [{ step_id: "run", type: "agent.execute", budget: { max_tokens: 2_000_000 }, depends_on: [] }]
    }),
    "budget_exceeds_host_limit"
  );
});

test("registry includes the first-step set and permission profiles", () => {
  const stepTypes = listStepTypes().map((entry) => entry.type).sort();
  assert.deepEqual(stepTypes, [
    "agent.classify",
    "agent.execute",
    "agent.filter",
    "agent.generate",
    "agent.judge_pair",
    "agent.review",
    "agent.synthesize",
    "command.collect",
    "command.verify",
    "human.approval",
    "workflow.include",
    "workflow.loop",
    "workflow.tournament"
  ]);
  assert.deepEqual(
    listPermissionProfiles()
      .map((entry) => entry.name)
      .sort(),
    [
      "classifier",
      "command_collector",
      "command_verifier",
      "executor_writer",
      "human_approval",
      "research",
      "reviewer_readonly",
      "synthesizer"
    ]
  );
});

test("skill plan reference documents registered step types and permission profiles", async () => {
  const reference = await readFile("skills/dynamic-workflow/references/plan.md", "utf8");
  for (const entry of listStepTypes()) {
    assert.ok(reference.includes(`\`${entry.type}\``), `Missing step type ${entry.type} in plan reference.`);
  }
  for (const profile of listPermissionProfiles()) {
    assert.ok(reference.includes(`\`${profile.name}\``), `Missing permission profile ${profile.name} in plan reference.`);
  }
});

test("docs and skill references document dataflow fields", async () => {
  const files = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("skills/dynamic-workflow/SKILL.md", "utf8"),
    readFile("skills/dynamic-workflow/references/plan.md", "utf8"),
    readFile("skills/dynamic-workflow/examples/dataflow-review-summarize.md", "utf8"),
    readFile("docs/07-js-first-dataflow-runtime.md", "utf8")
  ]);
  const combined = files.join("\n");
  for (const term of ["consumes", "produces", "$.verify.checks[*].stdout", "StepContext", "agent.synthesize"]) {
    assert.ok(combined.includes(term), `Missing dataflow docs term ${term}.`);
  }
  assert.match(files[0] ?? "", /dynamic-workflow/);
  assert.match(files[0] ?? "", /command\("collect_docs"/);
  assert.match(files[1] ?? "", /Use `consumes`/);
});
