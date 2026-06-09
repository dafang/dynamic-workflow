# Command Execution Quality

This document defines the runtime contract for command-backed workflow steps. It
turns command execution from an opaque step-level pass/fail into typed evidence
that can drive review, synthesis, diagnostics, and repair.

## 1. Problem Boundary

The original `command.verify` path is intentionally strict: every command runs
through the current backend, non-zero exits fail the step, and downstream nodes
are blocked. That is correct for final verification, but it is a poor fit for
evidence collection. Architecture audits, code searches, and repository probes
often have valuable partial output even when one search finds no matches or a
directory is absent.

The optimized contract keeps these two jobs separate:

- `command.verify` proves a required invariant. Failure blocks downstream work.
- `command.collect` gathers evidence. Optional gaps are recorded as structured
  check results and may continue into downstream `agent.review` or
  `agent.synthesize` through `consumes`.

The current executable backend remains `current`. Any unsupported external
backend must continue to fail closed during validation or compilation.

## 2. Step Semantics

### `command.verify`

Use `command.verify` for commands whose success is required for correctness:
tests, type checks, build checks, schema validation, security checks, or exact
artifact assertions.

Defaults:

- Each command must exit with code `0`.
- The step fails on the first unacceptable command result.
- Downstream steps depending on the failed verifier are blocked.
- Output is capped before it is written to artifacts.
- Trace records metadata only, not raw stdout or stderr.

`command.verify` may opt into explicit allowances, but those allowances must be
visible in the plan. A verifier with broad acceptable exit codes is still a
verifier: if a command result is not acceptable, the step fails.

### `command.collect`

Use `command.collect` for repository scans, evidence capture, exploratory
searches, listing files, extracting snippets, or optional probes.

Defaults:

- Exit code `0` is a successful check.
- Common evidence-gathering misses can be represented without failing the step
  when declared as acceptable by command options.
- The step succeeds when all required commands are successful or soft-failed
  commands are the only gaps.
- Gaps are emitted in `output.collection.gaps` and in per-command check objects.
- Downstream steps consume collection artifacts through explicit `consumes`
  selectors, for example `$.output.collection.checks[*].stdout`.

A collection step is not a substitute for final verification. Plans that gather
evidence and then mutate code should still end with strict `command.verify`
steps.

## 3. Command Declaration

Both command step types support a normalized command declaration model. Existing
`verify.commands: string[]` and legacy `input.commands: string[]` remain valid
for `command.verify`.

New plans should prefer command objects:

```yaml
steps:
  - step_id: collect_python_calls
    type: command.collect
    depends_on: []
    collect:
      commands:
        - id: py_calls
          run: "rg --glob '*.py' --glob '!{.venv,.dynamic-workflow,__pycache__}/**' 'def |class ' ."
          allow_exit_codes: [0, 1]
          soft_fail: true
          timeout_seconds: 30
          stdout_max_bytes: 20000
          stderr_max_bytes: 4000
```

Command object fields:

| Field | Type | Default | Meaning |
|---|---:|---:|---|
| `id` | string | command index | Stable identifier for trace and check objects. |
| `run` | string | required | Shell command executed by the current backend. |
| `allow_exit_codes` | number[] | `[0]` | Exit codes that count as acceptable for this command. |
| `soft_fail` | boolean | `false` for verify, `true` allowed for collect | If true, unacceptable exits become recorded gaps instead of step failure. |
| `timeout_seconds` | number | registry default | Per-command timeout, bounded by host step limits. |
| `stdout_max_bytes` | number | `2000` | Artifact stdout tail cap for the check result. |
| `stderr_max_bytes` | number | `2000` | Artifact stderr tail cap for the check result. |

String commands normalize to:

```json
{
  "id": "<index>",
  "run": "<string>",
  "allow_exit_codes": [0],
  "soft_fail": false,
  "stdout_max_bytes": 2000,
  "stderr_max_bytes": 2000
}
```

For `command.collect`, string commands are accepted for ergonomics but should be
linted when they look like optional probes without explicit allowances.

## 4. Artifacts

Command artifacts must remain bounded and structured.

For `command.verify`:

```json
{
  "output": {
    "status": "failed",
    "step_id": "verify",
    "checks": [
      {
        "id": "0",
        "command": "npm test",
        "exit_code": 1,
        "acceptable": false,
        "soft_failed": false,
        "failure_category": "nonzero_exit",
        "repair_hint": "Inspect stderr/stdout, fix the failing command, then rerun the verifier.",
        "elapsed_ms": 1240,
        "timed_out": false,
        "stdout": "...capped tail...",
        "stderr": "...capped tail...",
        "stdout_bytes": 25000,
        "stderr_bytes": 300
      }
    ]
  },
  "verify": {
    "ok": false,
    "checks": ["same check objects"]
  }
}
```

For `command.collect`:

```json
{
  "output": {
    "status": "succeeded",
    "step_id": "collect",
    "collection": {
      "ok": true,
      "checks": ["same check objects"],
      "gaps": [
        {
          "id": "missing_optional_dir",
          "failure_category": "missing_path",
          "repair_hint": "Confirm the path exists or mark the probe optional."
        }
      ]
    }
  },
  "verify": {
    "ok": true,
    "checks": []
  }
}
```

Downstream agents must use `consumes` to receive selected evidence. Runtime
dependencies still control ordering only; they do not imply context transfer.

## 5. Trace Events

Every command-backed step emits command-level trace events in addition to the
existing step events.

Start event:

```json
{
  "event": "command_started",
  "run_id": "run_1",
  "step_id": "collect",
  "data": {
    "command_index": 0,
    "command_id": "py_calls",
    "command_preview": "rg --glob '*.py' ...",
    "timeout_seconds": 30
  }
}
```

Completion event:

```json
{
  "event": "command_finished",
  "run_id": "run_1",
  "step_id": "collect",
  "data": {
    "command_index": 0,
    "command_id": "py_calls",
    "elapsed_ms": 27,
    "exit_code": 1,
    "signal": null,
    "timed_out": false,
    "acceptable": true,
    "soft_failed": false,
    "failure_category": "no_match",
    "stdout_bytes": 0,
    "stderr_bytes": 0
  }
}
```

Failure event:

```json
{
  "event": "command_failed",
  "run_id": "run_1",
  "step_id": "verify",
  "data": {
    "command_index": 0,
    "command_id": "tests",
    "elapsed_ms": 120000,
    "exit_code": null,
    "signal": "SIGTERM",
    "timed_out": true,
    "failure_category": "timeout",
    "repair_hint": "Raise timeout_seconds only after narrowing the command scope."
  }
}
```

Trace data must not include raw stdout or stderr. It may include a sanitized
`command_preview` capped to a small length.

## 6. Failure Taxonomy

Every failed or soft-failed command result includes one of these categories:

| Category | Detection rule | Typical repair hint |
|---|---|---|
| `timeout` | Process exceeded `timeout_seconds` or backend timeout. | Narrow the command scope or set a justified timeout. |
| `nonzero_exit` | Exit code is not acceptable and no better category matches. | Inspect capped output and fix the failing invariant. |
| `missing_path` | Stderr or shell error indicates absent file/directory/path. | Check the path or mark optional collection explicit. |
| `no_match` | Search command exits with no-match semantics, typically `rg` exit `1` without stderr. | Treat as empty evidence or broaden the query deliberately. |
| `shell_error` | Shell cannot parse/run command, command not found, permission denied, or signal failure. | Fix quoting, executable path, or permission assumptions. |
| `validation_error` | Plan declaration is invalid before execution. | Fix the plan fields and re-run `dw validate`. |
| `runtime_error` | Backend/context/artifact runtime raised outside command execution. | Inspect trace and step artifact for the runtime boundary. |

The category is heuristic for shell processes; validators and tests should cover
the common `rg` no-match, missing path, timeout, and command-not-found cases.

## 7. Plan Warnings

Plan validation remains fail-closed for schema errors. Quality issues that are
not invalid plans become warnings surfaced by `dw validate` and `dw compile`.

Initial warnings:

- Broad `rg --glob '*.py'` scans that do not exclude `.venv`,
  `.dynamic-workflow`, and `__pycache__`.
- Nested shell wrappers such as `/bin/sh -c "..."` or `sh -c "..."` inside a
  command step, because the runtime already uses a shell boundary.
- `command.verify` with multiple search/listing probes that look optional;
  suggest `command.collect`.
- Oversized command groups that mix evidence gathering and final verification.

Warnings must not block execution unless the plan also has validation errors.

## 8. External Backend Boundary

This repository currently executes only the `current` backend. That constraint
must be preserved:

- Plan-level or step-level `backend` values other than `current` remain
  validation errors.
- Runtime command execution changes do not introduce implicit external agent,
  remote shell, or network backends.
- Unsupported future adapters must fail closed until they implement the same
  artifact, trace, timeout, and taxonomy contract.

## 9. Implementation Targets

Phase 2 should change:

- `src/backends/current.ts` for normalized command execution, elapsed time,
  timeout detection, byte counts, caps, and check object metadata.
- `src/runtime.ts` and `src/trace.ts` for command-level trace event emission.
- `tests/runtime.test.ts` or `tests/workflow-modes.test.ts` for trace and
  timeout regression coverage.

Phase 3 should change:

- `src/types.ts` to add `command.collect`, command option types, and collect
  spec shape.
- `src/permissions.ts` and `src/registry.ts` to register collection semantics.
- `src/validation.ts` and `src/compiler.ts` to preserve normalized options.
- `src/backends/current.ts` to execute collection steps with partial-success
  semantics.
- Tests for optional no-match, missing path, strict verify failure, and
  downstream `consumes`.

Phase 4 should change:

- A warning surface in validation or a dedicated plan lint module.
- `src/commands/plan.ts` and `src/commands/compile.ts` so CLI users see
  warnings.
- Tests for warning text and structured warning codes.

Phase 5 should update:

- `README.md`
- `AGENTS.md`
- `skills/dynamic-workflow/SKILL.md`
- `skills/dynamic-workflow/commands/dynamic-workflow.md`
- `skills/dynamic-workflow/references/plan.md`
- `skills/dynamic-workflow/references/workflow-patterns.md`
- Templates and examples that currently show search/listing work as
  `command.verify`.
