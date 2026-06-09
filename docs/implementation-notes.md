# Implementation Notes

This file maps the design documents to the 0.1.0 MVP implementation.

## 00-index.md

- Implemented: typed plan is the canonical runtime input; validator, compiler, scheduler, trace, audit, CLI, and skill package are runnable.
- Safe MVP: JS harness is compile/capture only and does not execute arbitrary JavaScript.
- Deferred: external agent adapter protocols beyond `current`.

## 01-abstraction.md

- Implemented: workflow host, structured step registry, artifact store, trace store, verifier/audit, synthesizer step type, and permission profiles.
- Safe MVP: subagent execution is represented by the `current` host boundary rather than spawning external runtimes.
- Deferred: isolated worktrees and remote backend sessions.

## 02-patterns.md

- Implemented: fan-out/synthesize, adversarial verification, classify-and-act via `run_if` and `workflow.include`, bounded loop, generate/filter registry entries, and tournament expansion.
- Safe MVP: pattern examples live in the skill payload and compile through typed plans.

## 03-general-implementation-gaps.md

- Implemented: durable run ids, immutable plan/manifest files, step state, input/output artifact references, trace events, structured validation errors, permission profiles, scheduler readiness, resource locks, resume/status/review/summarize commands, and final audit.
- Safe MVP: retry policies and stale running-step recovery are represented in state and CLI shape but not a full distributed process manager.

## 04-js-runtime-and-agent-bridge.md

- Implemented: allowed SDK primitive list, denied capability policy, harness-to-plan capture, default `current` backend, and fail-closed external backend validation.
- Implemented: harness denied capability scanning ignores comments and string literals, rejects host/global APIs and computed property access in executable code, and rejects template expressions because they would execute arbitrary JavaScript.
- Implemented: harness capture ignores SDK-looking calls inside comments; sequential `agent()` calls after fan-out depend on the previous terminal step, while synthesizer calls merge current terminals.
- Safe MVP: generated JavaScript is not executed with Node permissions.
- Deferred: ACP/native adapter layers for Codex, Claude, Gemini, or remote runtimes.

## 05-skills-and-slash-commands.md

- Implemented: `.claude-plugin/` manifests, `skills/dynamic-workflow/SKILL.md`, command prompts for plan/run/review/status/resume, templates, scripts, references, and examples.
- Safe MVP: skill scripts delegate to `bin/dw.mjs`; runtime artifacts are kept outside the skill payload.

## 06-typed-plan-runtime.md

- Implemented: schema validation, step registry, dependency validation, cycle detection, budget limits, compiler DAG, ready queue, `run_if` preservation and runtime skipping, include/loop/tournament expansion, scheduler, structured outputs, trace, and final audit.
- Implemented: `command.verify` executes commands declared in canonical `verify.commands`; legacy `input.commands` remains accepted for existing plans.
- Implemented: dependencies and `run_if.step` references to control step ids are rewritten to terminal expanded nodes during compilation; compiled manifests fail closed if any dependency or condition references a missing node.
- Implemented: runtime evaluates `run_if.output_path` against the step output object, so `output_path: "status"` reads the emitted output status.
- Safe MVP: only `current` backend is executable.

## 07-js-first-dataflow-runtime.md

- Implemented: manifest v2 carries `consumes` and `produces`; validation checks selectors, aliases, upstream references, and context byte limits.
- Implemented: runtime builds `StepContext` from upstream step artifacts, clips oversized selected values, passes context to the backend, and records `context` / `context_sources` in `agent.*` artifacts.
- Implemented: JS harness captures `command(...)`, `agent.review(...)`, `agent.synthesize(...)`, `agent.execute(...)`, and `StepHandle.output(selector)` dataflow refs without executing arbitrary JavaScript.
- Implemented: CLI lifecycle validates, compiles, runs, reviews, summarizes, and resumes dataflow plans; summaries expose source metadata but not raw context payloads.
- Compatibility rule: existing `dynamic_workflow/run/v1` plans continue to run; if `consumes` is absent, runtime behaves like the scheduling-only MVP.
- Current limit: external Codex, Claude, ACP, and remote backend adapters are still deliberately rejected; only backend `current` executes.
