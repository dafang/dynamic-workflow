# Loop Until Done

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_loop
kind: implementation
steps:
  - step_id: repair_loop
    type: workflow.loop
    depends_on: []
    input:
      max_rounds: 3
      stop_condition: tests_pass
```
