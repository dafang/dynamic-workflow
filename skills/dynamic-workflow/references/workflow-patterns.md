# Workflow Patterns

- Fan-out and synthesize: independent analysis steps feed one `agent.synthesize` step.
- Adversarial verification: writer steps are followed by readonly `agent.review` steps.
- Classify and act: `agent.classify` feeds conditional `workflow.include` branches.
- Loop until done: `workflow.loop` can expand a body subgraph per round, pass `$previous` feedback from the prior terminal step, and short-circuit later rounds with `input.until`.
- Tournament: `workflow.tournament` compiles candidate comparisons into pairwise judges.
- Control dependencies: downstream `depends_on` and `run_if.step` may target a control step id; compilation rewrites them to the terminal expanded node.
- Collect evidence: use `command.collect` for bounded repository scans, snippets, and optional probes; consume `$.output.collection.checks[*].stdout` downstream.
- Verify commands: use `verify.commands` on strict `command.verify` steps for tests, build, lint, and final acceptance; `input.commands` remains accepted for compatibility.
- Repair diagnostics: read `collection.gaps`, `failure_category`, `repair_hint`, and plan warnings before rerunning or editing a workflow.
