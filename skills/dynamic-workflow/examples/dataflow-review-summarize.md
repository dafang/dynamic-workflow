# Dataflow Review And Synthesize

JS-first authoring shape:

```js
const docs = command("collect_docs", {
  run: ["sed -n '1,120p' README.md"],
});

const review = agent.review("review_docs", {
  prompt: "Review collected documentation for inconsistencies and missing evidence.",
  context: {
    docs: docs.output("$.output.collection.checks[*].stdout"),
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
    type: command.collect
    permission_profile: command_collector
    depends_on: []
    collect:
      commands:
        - id: readme_intro
          run: sed -n '1,120p' README.md
          timeout_seconds: 10
    produces:
      checks:
        select: $.output.collection.checks
        schema: command_collection/v1

  - step_id: review_docs
    type: agent.review
    depends_on: [collect_docs]
    consumes:
      - from: collect_docs
        select: $.output.collection.checks[*].stdout
        as: docs

  - step_id: summarize
    type: agent.synthesize
    depends_on: [review_docs]
    consumes:
      - from: review_docs
        select: $.output.status
        as: review_status
```
