# /dynamic-workflow

Run Dynamic Workflow through a single user-facing entry.

Argument behavior:

- If the user provides a task description, complete the full lifecycle in this single command: create a typed plan, validate it, compile it, show a concise manifest/risk summary, run it, then report status/review/summary for the resulting run id.
- If the user provides a plan path, validate, compile, run, then report status/review/summary for that plan.
- If the user provides a run id or asks for status, review, summary, or resume, resolve the run id and perform the requested lifecycle action.
- If the user provides no argument, resolve the most recent active workflow from this conversation or runtime root. Continue, review, summarize, or report status based on the latest state. Ask one short disambiguating question only when multiple candidates exist.
- Stop before execution only when the user explicitly asks for plan-only review.

Execution flow for new tasks:

1. Resolve the package root.
2. Resolve or create the plan.
3. Run `node bin/dw.mjs validate <plan>` and fix validation errors before execution.
4. Run `node bin/dw.mjs compile <plan>` and show a concise manifest summary.
5. Execute with `node bin/dw.mjs run <plan>`.
6. Preserve all `DW_*` markers in the transcript.
7. Run `status`, `review`, and `summarize` for the resulting run id.
8. For long autonomous execution, keep the same command lifecycle. If the host requires a `/goal` wrapper for unattended execution, create it as an internal continuation contract whose success condition requires `DW_RUN_COMPLETE`; do not turn it into an extra manual user step.

Output: plan path when relevant, run id, run directory, transcript markers, review status, summary, and next resume/status command when useful.
