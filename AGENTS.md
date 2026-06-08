# Agent Notes

Authoritative maintainer notes for agents working in this repo. README is for end users; this file is for implementation, testing, and iteration rules.

## What This Repo Is

Dynamic Workflow is a local TypeScript runtime and skill package for typed, auditable agent workflows. It validates a plan, compiles workflow controls into executable DAG nodes, runs those nodes through the `current` host backend, writes durable trace/artifact state, and exposes CLI commands for `validate`, `compile`, `run`, `status`, `review`, `resume`, and `summarize`.

The MVP backend is `current` only. Explicit external backend names such as `codex`, `claude`, `acp`, or remote backend names must fail closed.

## Repo Layout

```text
dynamic-workflow/
├── bin/dw.mjs                         CLI entrypoint
├── src/                               runtime, compiler, validation, CLI commands
├── tests/                             node:test suite
├── docs/                              design and implementation notes
├── skills/dynamic-workflow/            Codex/Claude skill payload
├── .claude-plugin/                    Claude plugin manifests
├── README.md                          final-user entrypoint
└── AGENTS.md                          maintainer and agent rules
```

## Standard Verification

Run these before handing off changes:

```sh
npm run build
npm run typecheck
npm test
npm run lint
```

Runtime artifacts belong under `.dynamic-workflow/` by default and must not be committed. For validation runs, prefer:

```sh
tmpdir=$(mktemp -d)
node bin/dw.mjs run <plan> --root "$tmpdir/runtime"
```

Then clean the temp dir, or use a shell `trap`.

## Runtime And Compiler Rules

- Typed plans remain canonical. Do not add behavior that only exists in prompt prose.
- New step types must be added to the registry, validation, compiler/runtime behavior if needed, tests, docs, and skill references.
- Every control step must compile to concrete executable nodes. Runtime should not need to interpret a raw `workflow.*` node after compilation.
- If compilation rewrites ids, dependencies and conditions must be rewritten together.
- Compiled manifests must fail closed on dangling dependencies, dangling `run_if`, unsupported backends, invalid permissions, and invalid output paths.
- `workflow.include`, `workflow.loop`, and `workflow.tournament` must be usable as natural dependency targets by plan authors. The compiler owns rewriting to terminal expanded nodes.
- `run_if.output_path` is evaluated against the step output object. Example: `output_path: status` reads the emitted output status.
- Writer conflict checks are part of the audit surface. If a plan needs parallel writers, give them distinct `input.resource_scope` values or add explicit dependencies.

## Harness Rules

- The JS harness bridge is compile/capture oriented; do not execute generated JavaScript with unrestricted Node permissions.
- Keep denied-capability checks conservative. A false rejection is better than a capability escape in executable harness code.
- Preserve the distinction between prompt text and executable code: comments and string literals should not trip denied-capability checks.
- Template expressions remain rejected because they execute JavaScript.
- Any new harness primitive must compile into the same typed plan surface the CLI accepts.
- If harness capture deduplicates step ids, every dependency must use the final deduplicated ids.

## Documentation Rules

- README is for final users: concept, install, agent-oriented quickstart, supported modes, artifacts, MVP limits.
- AGENTS.md is for maintainers and agents: build/test commands, invariants, validation rounds, release notes.
- Update `skills/dynamic-workflow/SKILL.md` when the skill workflow changes.
- Update `skills/dynamic-workflow/references/` when plan-authoring semantics change.
- Keep examples runnable through `node bin/dw.mjs validate`.
- Do not document an external backend as supported until it is executable and tested.

## Complex Validation Rounds

When a change touches orchestration semantics, run more than unit tests:

- Round 1: fan-out plus synthesize plus `command.verify`.
- Round 2: include plus `run_if` skip plus downstream continuation.
- Round 3: tournament plus loop plus downstream verify.
- Round 4: JS harness security and adversarial review dependency capture.
- Round 5: fix verification for issues found in prior rounds.

Paseo subagents are useful for these rounds. Before creating a Paseo agent, read `~/.paseo/orchestration-preferences.json` and use the configured provider for the agent role. Give each subagent an explicit temporary-artifact rule: all plans, scripts, and runtime output must live under `mktemp`, and CLI execution must use `--root <tmp>/runtime`.

Do not poll notify-on-finish Paseo agents while they run. Continue local work and read their activity after the finish notification arrives.

## Verified Coverage

The current implementation has been exercised with local tests and Paseo validation rounds across:

- Fan-out plus synthesize.
- Adversarial review.
- `workflow.include` with `run_if` skip.
- `workflow.tournament` pairwise expansion.
- `workflow.loop` bounded rounds.
- Control dependency rewriting for `depends_on` and `run_if.step`.
- `command.verify` with canonical `verify.commands`.
- JS harness capture, denied capability checks, prompt/comment false positive checks, sequential dependency capture, and duplicate step id dependency repair.
- CLI lifecycle: `validate`, `compile`, `run`, `status`, `review`, `summarize`, and `resume`.
- Failure/audit signals for queued/partial states, missing artifacts, unknown dependencies, unsupported backends, and writer conflicts.

Known MVP limits:

- `agent.filter` is registered but has not been deeply exercised as a complex end-to-end pattern.
- `human.approval` can enter `waiting_user`, but a full human-resume workflow is still future work.
- External backends are deliberately rejected.

## Pre-Handoff Checklist

1. Run `npm run build`.
2. Run `npm run typecheck`.
3. Run `npm test`.
4. Run `npm run lint`.
5. For workflow-mode changes, run at least one real CLI plan with `--root "$(mktemp -d)/runtime"` and confirm `DW_RUN_COMPLETE`.
6. For control-flow changes, inspect the compiled manifest for dangling `depends_on` and `run_if.step`.
7. For harness changes, test both denied executable code and allowed prompt/comment text.
8. Check that no `.dynamic-workflow`, `.DS_Store`, temporary plans, or runtime directories were left in the repo.

## Install Sync Notes

Codex install is usually a symlink or one-way copy into `~/.agents/skills/dynamic-workflow`; older local setups may also use `~/.codex/skills/dynamic-workflow`. After changing the skill payload, verify the local Codex install points at or matches `skills/dynamic-workflow/`.

Claude plugin manifests live under `.claude-plugin/`. If this project is published through a plugin flow, keep `package.json`, plugin manifests, changelog/release notes, README version notes, and the shipped skill payload aligned.

## Current Working State

- Version: `0.1.0` MVP, source of truth is `package.json`.
- Standard quality gate is `npm run build && npm run typecheck && npm test && npm run lint`.
- Latest validation round reached 48 passing tests after control dependency rewriting, `run_if.output_path` correction, and JS harness hardening.
