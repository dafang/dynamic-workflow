# Collect, Diagnose, Verify

Use collection for bounded evidence and strict verification for required proof.

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_collect_diagnose_verify
kind: review
steps:
  - step_id: collect_python_surface
    type: command.collect
    permission_profile: command_collector
    depends_on: []
    collect:
      commands:
        - id: python_defs
          run: "rg --glob '*.py' --glob '!{.venv,.dynamic-workflow,__pycache__}/**' 'def |class ' ."
          allow_exit_codes: [0, 1]
          soft_fail: true
          timeout_seconds: 30
    produces:
      checks:
        select: $.output.collection.checks
        schema: command_collection/v1

  - step_id: review_surface
    type: agent.review
    permission_profile: reviewer_readonly
    depends_on: [collect_python_surface]
    input:
      prompt: "Review collected Python surface for missing tests and risky ownership boundaries."
    consumes:
      - from: collect_python_surface
        select: $.output.collection.checks[*].stdout
        as: python_defs
        required: false
        max_bytes: 20000

  - step_id: verify_tests
    type: command.verify
    permission_profile: command_verifier
    depends_on: [review_surface]
    verify:
      commands:
        - id: tests
          run: npm test
          timeout_seconds: 120
```

If `collect_python_surface` records `collection.gaps`, inspect the gap
`failure_category` and `repair_hint` before changing the plan. Do not convert
the final `verify_tests` step into a collection step; required proof should stay
strict.
