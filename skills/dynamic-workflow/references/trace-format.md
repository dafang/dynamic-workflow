# Trace Format

Trace files are JSONL under `.dynamic-workflow/runs/<run_id>/trace.jsonl` by default, or `<root>/runs/<run_id>/trace.jsonl` when `--root <root>` is passed.

Core events:

- `workflow_created`
- `step_started`
- `step_succeeded`
- `step_failed`
- `step_waiting_user`
- `workflow_completed`
- `workflow_audited`
