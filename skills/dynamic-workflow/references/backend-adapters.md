# Backend Adapters

The default compiled backend is still `current`.

Omitted backend and `backend: current` execute through the current runtime boundary. Explicit plan-level or step-level `backend: codex`, `backend: claude`, `backend: acp`, or remote backend names still fail closed.

For real local agent execution, agent steps can opt into the Paseo bridge through step input while keeping `backend: current`:

```yaml
- step_id: implement
  type: agent.execute
  depends_on: [collect_context]
  input:
    agent_backend: paseo
    provider: codex/gpt-5.5
    mode: full-access
    cwd: /absolute/workspace/path
    wait_timeout: 45m
    title: DW implement module
    prompt: |
      Implement the requested module. Keep changes scoped and run local tests.
```

The runtime invokes `paseo run --json --provider ... --mode ... --cwd ... --wait-timeout ...` and records `agent_id`, `agent_status`, `provider`, `cwd`, and trace events in the step artifact. Use strict `command.verify` after delegated steps to prove the actual filesystem result.

The bridge can be configured with `input.paseo_cli` or `DW_PASEO_CLI` when the executable is not named `paseo`. `DW_PASEO_PROVIDER` and `DW_PASEO_MODE` provide defaults, but explicit step input is preferred for auditable plans.

The JS harness bridge also compiles into the current backend boundary. Harness code can choose workflow structure, but it cannot grant filesystem, shell, environment, network, or external backend access by itself.
