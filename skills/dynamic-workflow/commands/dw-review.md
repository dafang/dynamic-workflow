# /dw-review

Review an existing run with deterministic audit logic.

1. Resolve the run id from the user, recent `DW_RUN_START`, or the latest run under the active runtime root. If exactly one recent run is obvious, use it. If multiple candidates exist, ask one short disambiguating question.
2. Run `node bin/dw.mjs review <run-id>`.
3. Present structured findings and whether the audit is blocking.

Output: audit status, findings, and targeted fix recommendation if needed.
