# Loop Until Done

Use a loop body when each round must act on the previous round's review and
fresh verification evidence.

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_loop_until_done
kind: implementation
steps:
  - step_id: collect_context
    type: command.collect
    permission_profile: command_collector
    depends_on: []
    collect:
      commands:
        - id: target_files
          run: rg -n "TODO|FIXME|failing test" src tests
          allow_exit_codes: [0, 1]
          soft_fail: true
          timeout_seconds: 20

  - step_id: repair_loop
    type: workflow.loop
    depends_on: [collect_context]
    input:
      max_rounds: 3
      stop_condition: no_blockers
      until:
        output_path: blocking_count
        op: ==
        value: 0
      body:
        - step_id: execute
          type: agent.execute
          permission_profile: executor_writer
          depends_on: []
          input:
            prompt: Fix the current blocking implementation issues.
          consumes:
            - from: collect_context
              select: $.output.collection.checks[*].stdout
              as: context
              required: false
            - from: $previous
              select: $.output.findings
              as: previous_findings
              required: false

        - step_id: collect_tests
          type: command.collect
          permission_profile: command_collector
          depends_on: [execute]
          collect:
            commands:
              - id: tests
                run: npm test
                allow_exit_codes: [0, 1]
                soft_fail: true
                timeout_seconds: 120

        - step_id: review
          type: agent.review
          permission_profile: reviewer_readonly
          depends_on: [collect_tests]
          input:
            prompt: Review the latest implementation and return blocking_count plus findings.
          consumes:
            - from: collect_tests
              select: $.output.collection.checks
              as: verification

  - step_id: summarize
    type: agent.synthesize
    permission_profile: synthesizer
    depends_on: [repair_loop]
    consumes:
      - from: repair_loop
        select: $.output.blocking_count
        as: final_blocking_count
```
