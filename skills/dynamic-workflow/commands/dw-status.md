# /dw-status

Report workflow and per-step state.

1. Resolve the run id from the user, recent `DW_RUN_START`, or the latest run under the active runtime root. If exactly one recent run is obvious, use it. If multiple candidates exist, ask one short disambiguating question.
2. Run `node bin/dw.mjs status <run-id>`.
3. Summarize state without raw prompts, secrets, or debug details.

Output: workflow state, step states, and trace path.
