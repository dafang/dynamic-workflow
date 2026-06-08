---
name: dynamic-workflow
description: Use for complex work that benefits from a typed, auditable workflow with validation, compilation, durable trace, review, resume, and summary. The user-facing entry is dynamic-workflow; lifecycle commands are internal phases. Do not use for simple one-step tasks where orchestration costs more than execution.
---

# Dynamic Workflow

Use this skill when a user asks for a complex task to be decomposed, executed, reviewed, resumed, or summarized with durable evidence. Skip it for simple edits, quick questions, or tasks that cannot be usefully split into typed steps.

## Required Flow

1. Resolve two paths separately:
   - Skill directory: the directory containing this `SKILL.md`.
   - Package root: the repository/runtime root containing `package.json` and `bin/dw.mjs`.
2. Write or select a typed plan from `<skill_dir>/templates/plan.yaml`; for non-trivial plans, read `<skill_dir>/references/plan.md` for the supported step types and fields.
3. Run `node <package_root>/bin/dw.mjs validate <plan>` and fix structured validation errors before execution.
4. Run `node <package_root>/bin/dw.mjs compile <plan>` and show a concise manifest/risk summary.
5. For `dynamic-workflow <task>` or a natural-language run request, continue in one user operation through `node <package_root>/bin/dw.mjs run <plan>`, then preserve the `DW_*` transcript markers.
6. Run `status`, `review`, and `summarize` for the resulting run id. Use `resume` when continuing an existing run.
7. If the package root cannot be resolved from the skill install, try `<skill_dir>/scripts/dw`; if that also cannot find the runtime, report the missing runtime path instead of reading `src/` to infer behavior.

## Safety Rules

- Typed plans are canonical; prompt prose is not an execution contract.
- Backend defaults to `current`; explicit `codex`, `claude`, `acp`, or remote backend names fail closed in the MVP.
- Runtime artifacts default to `.dynamic-workflow/runs/<run_id>/`; when `--root <dir>` is passed, artifacts are written under `<dir>/runs/<run_id>/`.
- Command prompts may call the CLI or scripts wrapping the CLI, but must not duplicate divergent runtime logic.
- Summaries must omit secrets, raw internal prompts, token/debug details, and unnecessary local paths.
- Do not read runtime source files to infer the plan schema; use `<skill_dir>/templates/plan.yaml` and `<skill_dir>/references/plan.md`.

## Output Contract

Successful runs print `DW_RUN_START`, one or more `DW_STEP_START` / `DW_STEP_VERIFY` / `DW_STEP_DONE` groups, `DW_REVIEW_START`, `DW_REVIEW_COMPLETE`, and `DW_RUN_COMPLETE`. Failed runs must surface structured errors and preserve trace files for review.

## Runtime Directory Resolution

Use `.dynamic-workflow` under the current repository by default. Pass `--root <dir>` only when the user asks for an alternate runtime location or tests need isolation; that alternate root contains its own `runs/<run_id>/` directory.
