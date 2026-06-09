# Typed Plan Reference

This is the plan authoring contract for the current runtime. The executable source of truth is `src/types.ts`, `src/registry.ts`, `src/validation.ts`, and `src/compiler.ts`; this reference mirrors those files for skill users.

## Top-Level Fields

Required:

- `schema_version`: must be `dynamic_workflow/run/v1`.
- `workflow_id`: stable run family id. It becomes part of generated run ids.
- `steps`: non-empty array of workflow steps. The runtime also accepts `plan.steps` for compatibility, but new plans should use top-level `steps`.

Optional:

- `kind`: free-form workflow kind. Common values are `mixed`, `review`, `research`, and `implementation`.
- `scope_id`: optional external task, issue, PR, or feature id.
- `request`: original user request or concise task summary.
- `backend`: omit or set `current`. Explicit `codex`, `claude`, `acp`, or remote backends fail closed in the MVP.
- `budget`: workflow-level positive integer limits.
- `metadata`: arbitrary JSON object for caller metadata.

Workflow budget fields:

- `max_steps`: maximum 200.
- `max_subagents`: maximum 64.
- `max_rounds`: maximum 20.
- `max_minutes`: maximum 480.

## Common Step Fields

Required:

- `step_id`: unique stable id. Dependencies, conditions, trace events, and artifacts use this id.
- `type`: one of the registered step types below.
- `depends_on`: array of step ids. Use `[]` for initial steps.

Optional:

- `title`: human-readable label.
- `input`: JSON object passed to the step or compiler.
- `permission_profile`: explicit permission profile. If omitted, the registry default for the step type is used.
- `backend`: omit or set `current`; other values fail validation.
- `budget`: step-level positive integer limits.
- `run_if`: condition evaluated before execution.
- `strategy`: free-form strategy hint.
- `verify`: verification spec.
- `consumes`: optional array of upstream artifact selections injected into the step context.
- `produces`: optional object naming stable output selections for downstream authors.

Step budget fields:

- `max_rounds`: maximum 20.
- `max_minutes`: maximum 240.
- `max_tokens`: maximum 1000000.

`input.resource_scope` is optional. It sets the read/write lock scope for conflict detection. When omitted, the scope is `workspace`.

## Dataflow Fields

`depends_on` controls readiness only. It does not pass output content to another step. Use `consumes` when a downstream step needs upstream evidence.

```yaml
- step_id: collect_docs
  type: command.verify
  depends_on: []
  verify:
    commands:
      - sed -n '1,120p' README.md
  produces:
    checks:
      select: $.verify.checks
      schema: command_checks/v1

- step_id: review_docs
  type: agent.review
  depends_on: [collect_docs]
  consumes:
    - from: collect_docs
      select: $.verify.checks[*].stdout
      as: docs
      required: true
      max_bytes: 20000
```

`consumes` fields:

- `from`: upstream step id. It must be a dependency upstream; control step ids are rewritten to terminal expanded nodes when unambiguous.
- `select`: supported artifact selector. Current selector subset starts at `$`, supports dotted object fields, and supports array wildcard `[*]`, for example `$.verify.checks[*].stdout` and `$.output.status`.
- `as`: context alias matching `[A-Za-z_][A-Za-z0-9_]*`.
- `required`: optional boolean. Omitted means required. `false` records an empty source when the artifact or selector is missing.
- `max_bytes`: optional positive integer up to 1000000. Omitted defaults to 20000. Oversized selected values are clipped deterministically and source metadata records `clipped`, `original_bytes`, and `selected_bytes`.

`produces` fields:

- Each key names a stable output contract such as `checks`.
- `select`: selector for the produced value.
- `schema`: optional schema label such as `command_checks/v1`.

At runtime, each consuming step receives a `StepContext`:

- `inputs`: JSON object keyed by consume alias.
- `sources`: source metadata with alias, upstream step, selector, artifact path, clipping flag, and byte counts.

Current `agent.*` artifacts record `context` and `context_sources`. `dw summarize` reports source metadata only; it does not print raw context payloads.

## Conditions

`run_if` shape:

```yaml
run_if:
  step: classify
  output_path: label
  op: ==
  value: implementation
```

Fields:

- `step`: referenced step id. It may reference a control step id; compile rewrites it to the terminal expanded node when unambiguous.
- `output_path`: dotted path relative to the referenced step artifact's `output` object. Each segment must match `[A-Za-z_][A-Za-z0-9_]*`.
- `op`: one of `==`, `!=`, `>`, `>=`, `<`, `<=`, `exists`, `not_exists`.
- `value`: optional JSON value. Required by comparison convention for equality and numeric comparisons; ignored by `exists` and `not_exists`.

## Verification

`command.verify` requires commands in `verify.commands`:

```yaml
- step_id: test
  type: command.verify
  depends_on: [implement]
  verify:
    commands:
      - npm test
```

Compatibility: `input.commands` is still accepted for existing plans, but new plans should use `verify.commands`.

Other `verify` fields:

- `required_artifacts`: array of artifact names or paths expected from the step.
- `output_schema`: JSON object describing expected output shape.

`command.collect` gathers evidence without treating explicitly optional misses as blockers:

```yaml
- step_id: collect_sources
  type: command.collect
  depends_on: []
  collect:
    commands:
      - id: py_defs
        run: "rg --glob '*.py' --glob '!{.venv,.dynamic-workflow,__pycache__}/**' 'def |class ' ."
        allow_exit_codes: [0, 1]
        soft_fail: true
        timeout_seconds: 30
```

Collection outputs are written under `$.output.collection.checks` and gaps under
`$.output.collection.gaps`. Downstream agent steps should consume collection
evidence explicitly with `consumes`.

## Registered Step Types

| Type | Purpose | Default profile | Allowed profiles | Control | Writes |
| --- | --- | --- | --- | --- | --- |
| `agent.classify` | Classify input into labels or branches. | `classifier` | `classifier`, `research` | no | no |
| `agent.execute` | Execute a focused implementation step through the current host agent. | `executor_writer` | `executor_writer` | no | yes |
| `agent.review` | Perform readonly adversarial or quality review. | `reviewer_readonly` | `reviewer_readonly`, `research` | no | no |
| `agent.synthesize` | Merge structured outputs into a final answer or artifact. | `synthesizer` | `synthesizer` | no | yes |
| `agent.generate` | Generate candidate plans, options, or artifacts. | `research` | `research`, `executor_writer` | no | no |
| `agent.filter` | Filter or rank candidate outputs against criteria. | `synthesizer` | `synthesizer`, `reviewer_readonly` | no | no |
| `agent.judge_pair` | Judge two candidates and emit a structured winner. | `reviewer_readonly` | `reviewer_readonly` | no | no |
| `workflow.include` | Compile an allowlisted built-in workflow into the graph. | `synthesizer` | `synthesizer` | yes | no |
| `workflow.loop` | Compile a bounded loop into resumable rounds. | `synthesizer` | `synthesizer` | yes | no |
| `workflow.tournament` | Compile candidate comparisons into pairwise judge steps. | `synthesizer` | `synthesizer` | yes | no |
| `command.collect` | Run evidence collection commands and preserve partial results. | `command_collector` | `command_collector` | no | no |
| `command.verify` | Run verification commands and capture structured results. | `command_verifier` | `command_verifier` | no | no |
| `human.approval` | Pause execution until a human approves, rejects, or revises a step. | `human_approval` | `human_approval` | no | no |

## Agent Step Inputs

The runtime accepts arbitrary JSON in `input`, but these keys have established meaning:

- `prompt`: instruction for the current host agent boundary.
- `resource_scope`: lock scope for conflict detection.
- `review_target`: step id or artifact target for review.
- `force_fail`: test fixture flag; `true` forces failure in the current backend and should not be used in real plans.

Candidate and comparison steps commonly use:

- `criteria`: array of strings used by `agent.filter`, `agent.judge_pair`, or `workflow.tournament`.
- `candidate_a`, `candidate_b`: candidate step ids for `agent.judge_pair`. Control step ids are rewritten to terminal nodes when unambiguous.

## Control Step Inputs

### `workflow.include`

Required input:

```yaml
input:
  workflow_ref: builtin.feature
```

Accepted refs in the MVP:

- `builtin.feature`: expands to an `agent.execute` implementation step followed by an `agent.review` step.
- `builtin.bugfix`: expands to an `agent.review` diagnosis step followed by an `agent.execute` fix step.

`input.ref` is accepted as an alias for `input.workflow_ref`.

Expansion behavior:

- Expanded ids use `<control_step_id>__<included_step_id>`.
- Included entry steps depend on the control step's `depends_on`.
- Included internal dependencies are prefixed.
- The control step's `run_if` applies to included steps unless an included step supplies its own condition.

### `workflow.loop`

Required input:

```yaml
input:
  max_rounds: 3
  stop_condition: tests_pass
```

Compile behavior:

- Expands to `agent.execute` nodes named `<step_id>__round_1`, `<step_id>__round_2`, and so on.
- Each round depends on the previous round; round 1 depends on the control step's `depends_on`.
- `max_rounds` must be a positive integer and cannot exceed 20.
- `stop_condition` is recorded in each round input. The current MVP compiles bounded rounds; it does not dynamically terminate early based on the condition.

### `workflow.tournament`

Required input:

```yaml
input:
  candidate_steps: [candidate_a, candidate_b, candidate_c]
  criteria: [correctness, risk, maintainability]
```

Compile behavior:

- `candidate_steps` must contain at least two step ids.
- Expands to pairwise `agent.judge_pair` nodes named `<step_id>__judge_1`, `<step_id>__judge_2`, and so on.
- Judge 1 compares the first two candidates. Each later judge compares the previous judge winner against the next candidate.
- `criteria` is copied into each judge input.

## Control Dependencies

Plan authors may use control step ids in `depends_on` and `run_if.step`.

At compile time:

- `depends_on: [repair_loop]` rewrites to the terminal expanded node, such as `repair_loop__round_3`.
- `run_if.step: tournament` rewrites to the single terminal judge node.
- `consumes.from: tournament` rewrites to the single terminal judge node.
- Rewrites fail closed when a control step expands to zero terminal nodes or when a single-step reference is ambiguous.

## Permission Profiles

- `classifier`: no write or shell access; may read untrusted input.
- `executor_writer`: write-capable current-host execution with limited shell.
- `reviewer_readonly`: read/search review without mutation.
- `synthesizer`: artifact read/write for merging outputs.
- `research`: project and external reference reading without workspace mutation.
- `command_verifier`: verification shell commands only.
- `command_collector`: bounded evidence collection shell commands only.
- `human_approval`: user approval only.

Permission profiles are validated against step type allowlists. Prompt text cannot grant extra permissions.

## Current MVP Limits

- Only backend `current` executes.
- Compiled manifests use `dynamic_workflow/compiled/v2`; existing `dynamic_workflow/run/v1` plans without dataflow fields remain valid.
- If `consumes` is absent, runtime behavior matches the old scheduling-only MVP.
- Control steps compile before runtime; runtime executes concrete nodes.
- `workflow.loop` is bounded and does not short-circuit early yet.
- `human.approval` enters `waiting_user`; a full approve/reject/revise resume workflow is still host-dependent.
- `command.verify` and `command.collect` commands run through `sh -c` and capture capped stdout/stderr in artifacts.
- Step outputs are sanitized before being written to user-facing artifacts; secret, token, password, raw prompt, internal prompt, and debug keys are removed recursively.
