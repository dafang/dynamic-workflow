# Workflow Mode Matrix

This fixture records the workflow surfaces covered by `tests/workflow-modes.test.ts`.
It must stay in the tracked test fixture tree, not under local planning state such as
`.supergoal/`, so `npm test` works in a clean clone.

## Registered Step Types

- `agent.classify`
- `agent.execute`
- `agent.review`
- `agent.synthesize`
- `agent.generate`
- `agent.filter`
- `agent.judge_pair`
- `workflow.include`
- `workflow.loop`
- `workflow.tournament`
- `command.collect`
- `command.verify`
- `human.approval`

## Validation Surfaces

- Sequential Dataflow Module Review
- Fan-Out Generate/Review/Filter/Synthesize
- Agent Output Contract Dataflow
- Conditional Include Feature/Bugfix
- Loop + Tournament Chain
- Human Gate + Failure/Resume
- JS-First Harness Capture
