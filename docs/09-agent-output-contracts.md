# Agent Output Contracts

Dynamic Workflow agent steps are valuable only when later steps can reliably consume their results. Every `agent.*` step therefore has a built-in output contract under `artifact.output`. Runtime may keep additive compatibility fields such as `status`, `summary`, `context`, and `context_sources`, but the fields below are the stable dataflow surface.

## Built-In Contracts

| Step type | Required stable fields | Purpose |
| --- | --- | --- |
| `agent.classify` | `label`, `confidence` | Choose a branch label that `run_if` can test. |
| `agent.review` | `ok`, `findings`, `blocking_count` | Report review results and whether blockers remain. |
| `agent.synthesize` | `summary`, `decisions`, `next_actions` | Merge upstream evidence into an actionable result. |
| `agent.generate` | `candidates` | Produce candidate designs, plans, or artifacts for later filtering or judging. |
| `agent.filter` | `accepted`, `rejected` | Split candidate ids by criteria. |
| `agent.judge_pair` | `winner`, `loser`, `rationale` | Compare two candidate ids and explain the decision. |
| `agent.execute` | `artifacts` | Report durable files, commands, or outputs created by an implementation step. |

All built-in contracts also allow a bounded `metadata` object for provenance. For delegated Paseo steps, runtime may add backend metadata such as `agent_backend`, `agent_id`, `agent_status`, `provider`, `cwd`, `title`, and `elapsed_ms`.

## Schema Subset

The runtime supports a bounded JSON Schema subset for agent output validation:

- `type`: one of `object`, `array`, `string`, `number`, `integer`, or `boolean`
- `required`
- `properties`
- `items`
- `enum`
- `additionalProperties`

Unsupported keywords are intentionally ignored by the contract design until the runtime explicitly implements them. Plans should not depend on keywords such as `oneOf`, `anyOf`, `allOf`, `pattern`, `minimum`, `maximum`, `minItems`, or `format`.

## Built-In And Step-Specific Schemas

Built-in contracts are mandatory for their step type. Step authors can add stricter requirements with either:

- `input.output_schema`: preferred for agent steps because it is part of the requested output contract.
- `verify.output_schema`: accepted for compatibility with existing verification declarations.

Step-specific schemas add requirements; they do not weaken built-in fields. If an agent omits a required built-in field, emits invalid JSON, or fails a step-specific schema, the step fails and downstream dependents are blocked.

## Dataflow Examples

Branch on a classifier result:

```yaml
- step_id: classify_request
  type: agent.classify
  depends_on: []
  input:
    prompt: Classify this request as feature, bugfix, research, or docs.

- step_id: feature_flow
  type: workflow.include
  depends_on: [classify_request]
  input:
    workflow_ref: builtin.feature
  run_if:
    step: classify_request
    output_path: label
    op: ==
    value: feature
```

Consume review fields downstream:

```yaml
- step_id: review_impl
  type: agent.review
  depends_on: [implement]

- step_id: summarize_review
  type: agent.synthesize
  depends_on: [review_impl]
  consumes:
    - from: review_impl
      select: $.output.blocking_count
      as: blocking_count
    - from: review_impl
      select: $.output.findings
      as: findings
```

Require a step-specific field while preserving the built-in contract:

```yaml
- step_id: classify_package
  type: agent.classify
  depends_on: []
  input:
    prompt: Classify the package risk.
    output_schema:
      type: object
      required: [risk_area]
      properties:
        risk_area:
          type: string
          enum: [runtime, docs, tests]
      additionalProperties: true
```

## Runtime Contract

Runtime enforcement is fail closed:

1. Ask the agent for JSON matching the built-in contract and any step-specific schema.
2. Parse the JSON output.
3. Validate built-in fields and additional schema requirements.
4. Merge validated fields into `artifact.output`.
5. Fail the step with `agent_output_parse_failed` or `schema_validation_failed` when parsing or validation fails.
6. Block downstream dependents for failed agent steps.

This makes `depends_on` order, `run_if` branches, and `consumes` dataflow semantically connected instead of merely sequenced.
