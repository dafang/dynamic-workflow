# /dw-run

Plan and run a typed workflow end-to-end, or run the most recent approved plan.

Argument behavior:

- If the user provides a plan path, validate and run that plan.
- If the user provides a task description, complete the full lifecycle in this single command: create a typed plan, validate it, compile it, show a concise manifest/risk summary, run it, then report status/review/summary for the resulting run id.
- If the user provides no argument, resolve the most recent validated or approved plan from this conversation or `.dynamic-workflow/plans/`. If exactly one candidate is obvious, run it. If multiple candidates exist, ask one short disambiguating question.
- If the user wants plan review before execution, they must use `/dw-plan` instead of `/dw-run`.

Execution flow:

1. Resolve the package root.
2. Resolve or create the plan.
3. Run `node bin/dw.mjs validate <plan>` and fix validation errors before execution.
4. Run `node bin/dw.mjs compile <plan>` and show a concise manifest summary.
5. Execute with `node bin/dw.mjs run <plan>`.
6. Preserve all `DW_*` markers in the transcript.
7. Run `status`, `review`, and `summarize` for the resulting run id.
8. For long autonomous execution, keep the same command lifecycle. If the host requires a `/goal` wrapper for unattended execution, create it as an internal continuation contract whose success condition requires `DW_RUN_COMPLETE`; do not turn it into an extra manual user step.

Output: plan path, run id, run directory, transcript markers, review status, summary, and next resume/status command.
