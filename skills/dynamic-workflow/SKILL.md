---
name: dynamic-workflow
description: Use for complex work that benefits from a typed, auditable workflow with validation, compilation, durable trace, review, resume, and summary commands. Do not use for simple one-step tasks where orchestration costs more than execution.
---

# Dynamic Workflow

Use this skill when a user asks for a complex task to be decomposed, executed, reviewed, resumed, or summarized with durable evidence. Skip it for simple edits, quick questions, or tasks that cannot be usefully split into typed steps.

## Required Flow

1. Resolve the package root by locating `package.json` or this skill directory.
2. Write or select a typed plan based on `templates/plan.yaml`.
3. Run `node bin/dw.mjs validate <plan>` and fix structured validation errors before execution.
4. Run `node bin/dw.mjs compile <plan>` when the user needs a manifest review.
5. For `/dw-run <task>` or a natural-language run request, continue in one user operation through `node bin/dw.mjs run <plan>`, then preserve the `DW_*` transcript markers.
6. Use `status`, `review`, `resume`, and `summarize` commands rather than reading runtime internals directly.

## Safety Rules

- Typed plans are canonical; prompt prose is not an execution contract.
- Backend defaults to `current`; explicit `codex`, `claude`, `acp`, or remote backend names fail closed in the MVP.
- Runtime artifacts default to `.dynamic-workflow/runs/<run_id>/`; when `--root <dir>` is passed, artifacts are written under `<dir>/runs/<run_id>/`.
- Command prompts may call the CLI or scripts wrapping the CLI, but must not duplicate divergent runtime logic.
- Summaries must omit secrets, raw internal prompts, token/debug details, and unnecessary local paths.

## Output Contract

Successful runs print `DW_RUN_START`, one or more `DW_STEP_START` / `DW_STEP_VERIFY` / `DW_STEP_DONE` groups, `DW_REVIEW_START`, `DW_REVIEW_COMPLETE`, and `DW_RUN_COMPLETE`. Failed runs must surface structured errors and preserve trace files for review.

## Runtime Directory Resolution

Use `.dynamic-workflow` under the current repository by default. Pass `--root <dir>` only when the user asks for an alternate runtime location or tests need isolation; that alternate root contains its own `runs/<run_id>/` directory.
