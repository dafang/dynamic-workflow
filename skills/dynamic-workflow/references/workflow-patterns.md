# Workflow Patterns

- Fan-out and synthesize: independent analysis steps feed one `agent.synthesize` step.
- Adversarial verification: writer steps are followed by readonly `agent.review` steps.
- Classify and act: `agent.classify` feeds conditional `workflow.include` branches.
- Loop until done: `workflow.loop` compiles to bounded rounds with a stop condition.
- Tournament: `workflow.tournament` compiles candidate comparisons into pairwise judges.
- Control dependencies: downstream `depends_on` and `run_if.step` may target a control step id; compilation rewrites them to the terminal expanded node.
- Verify commands: prefer `verify.commands` on `command.verify` steps; `input.commands` remains accepted for compatibility.
