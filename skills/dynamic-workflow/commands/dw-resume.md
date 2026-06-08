# /dw-resume

Resume or inspect resumability for a previous run.

1. Resolve the run id from the user, recent `DW_RUN_START`, or the latest resumable run under the active runtime root. If exactly one recent run is obvious, use it. If multiple candidates exist, ask one short disambiguating question.
2. Run `node bin/dw.mjs resume <run-id>`.
3. Reuse succeeded step results and continue only pending or stale work when runtime support allows it.

Output: reused step count, pending count, current state, and next action.
