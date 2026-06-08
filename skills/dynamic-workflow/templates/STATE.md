# Dynamic Workflow Run State

Run ID: `<run_id>`
Workflow ID: `<workflow_id>`
State: `draft|validated|running|completed|failed|waiting_user|cancelled|partial_succeeded`

Step table is maintained by `.dynamic-workflow/runs/<run_id>/run.json` by default, or `<root>/runs/<run_id>/run.json` when a command is invoked with `--root <root>`.
