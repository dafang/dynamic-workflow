# Fan-out and Synthesize

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_fanout
kind: review
steps:
  - step_id: review_gateway
    type: agent.review
    depends_on: []
  - step_id: review_runtime
    type: agent.review
    depends_on: []
  - step_id: synthesize
    type: agent.synthesize
    depends_on: [review_gateway, review_runtime]
```
