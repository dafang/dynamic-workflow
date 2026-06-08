# /dw-plan

Plan only. Do not execute workflow steps in this command.

1. Draft a typed plan from `../templates/plan.yaml`.
2. Save it under `.dynamic-workflow/plans/` or a user-requested path.
3. Run `node bin/dw.mjs validate <plan>`.
4. If valid, optionally run `node bin/dw.mjs compile <plan>` and show a concise manifest summary.
5. Ask the user to review or approve the plan before running.

Output: plan path, validation status, key steps, risks, and next command.
