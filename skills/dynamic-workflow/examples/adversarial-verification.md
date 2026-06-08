# Adversarial Verification

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_adversarial
kind: implementation
steps:
  - step_id: implement
    type: agent.execute
    permission_profile: executor_writer
    depends_on: []
  - step_id: review
    type: agent.review
    permission_profile: reviewer_readonly
    depends_on: [implement]
```
