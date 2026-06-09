# Dataflow Review And Synthesize

JS-first authoring shape:

```js
const docs = command("collect_docs", {
  run: ["sed -n '1,120p' README.md"],
});

const review = agent.review("review_docs", {
  prompt: "Review collected documentation for inconsistencies and missing evidence.",
  context: {
    docs: docs.output("$.verify.checks[*].stdout"),
  },
});

agent.synthesize("summarize", {
  prompt: "Summarize the review result with evidence.",
  context: {
    reviewStatus: review.output("$.output.status"),
  },
});
```

Equivalent typed IR:

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_dataflow_review
kind: review
steps:
  - step_id: collect_docs
    type: command.verify
    depends_on: []
    verify:
      commands:
        - sed -n '1,120p' README.md
    produces:
      checks:
        select: $.verify.checks
        schema: command_checks/v1

  - step_id: review_docs
    type: agent.review
    depends_on: [collect_docs]
    consumes:
      - from: collect_docs
        select: $.verify.checks[*].stdout
        as: docs

  - step_id: summarize
    type: agent.synthesize
    depends_on: [review_docs]
    consumes:
      - from: review_docs
        select: $.output.status
        as: review_status
```
