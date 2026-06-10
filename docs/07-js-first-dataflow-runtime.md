# JS-First Dataflow Runtime

本文记录 Dynamic Workflow 从 typed YAML-first 演进到 JS-first authoring 的 dataflow runtime。执行、审计和恢复仍由 manifest IR 驱动。

## 1. 问题

当前 typed plan 的 `depends_on` 主要表达调度顺序：

```yaml
step_b depends_on: [step_a]
```

这只能说明 `step_a` 成功后才能运行 `step_b`。它没有说明：

- `step_b` 需要消费 `step_a` 的哪部分结果。
- runtime 应该把哪些 artifact 注入 `step_b` 上下文。
- 下游 agent 是否真的使用了上游证据。
- resume 时哪些上游 artifact 可复用。

结果是 workflow 容易退化成“有序命令清单”。这对 trace 有价值，但对复杂 agent workflow 的核心价值不够。

## 2. 目标架构

目标不是“JS 编译成 YAML”。目标是：

```text
workflow.js
  -> capture workflow graph and data references
  -> compiled_manifest.json
  -> runtime executes manifest
  -> trace.jsonl + steps/*.json + artifacts/**
```

其中：

- `workflow.js` 是 authoring DSL，负责表达组合和数据引用。当前实现支持 `command(...)`、`agent.review(...)`、`agent.synthesize(...)`、`agent.execute(...)` 和 `StepHandle.output(selector)` 的保守 capture。
- `compiled_manifest.json` 是执行 IR，也是审计和恢复的唯一依据。
- YAML/JSON typed plan 是可选导入导出格式，不是主入口。
- runtime 不恢复 JS call stack；runtime 恢复 manifest state 和 artifact store。

## 3. JS DSL 语义

JS 只拥有 workflow SDK，不拥有系统能力。

示例：

```js
const docs = command("collect_docs", {
  run: [
    "sed -n '1,220p' README.md",
    "sed -n '1,220p' skills/dynamic-workflow/SKILL.md",
  ],
});

const review = agent.review("review_docs", {
  prompt: "Review README/SKILL/template consistency. Return structured findings.",
  context: {
    docs: docs.output("$.output.collection.checks[*].stdout"),
  },
});

agent.synthesize("summary", {
  prompt: "Summarize the review with evidence.",
  context: {
    findings: review.output("$.output.findings"),
  },
});
```

`docs.output(...)` 返回 `ArtifactRef`。任何 step 引用另一个 step 的 output，runtime 自动产生：

- 调度依赖。
- 数据依赖。
- manifest 中的 `consumes` 条目。
- resume 时的 artifact 读取规则。

## 4. Manifest IR

manifest 应该显式区分调度依赖和数据依赖：

```json
{
  "manifest_version": "dynamic_workflow/compiled/v2",
  "nodes": [
    {
      "step_id": "review_docs",
      "type": "agent.review",
      "depends_on": ["collect_docs"],
      "consumes": [
        {
          "from": "collect_docs",
          "select": "$.output.collection.checks[*].stdout",
          "as": "docs",
          "required": true,
          "max_bytes": 20000
        }
      ],
      "input": {
        "prompt": "Review README/SKILL/template consistency. Return structured findings."
      }
    }
  ]
}
```

Rules:

- `depends_on` controls readiness only.
- `consumes` controls context injection.
- Every `consumes.from` must reference an upstream node. Control step ids are rewritten to terminal expanded nodes when unambiguous.
- Every `select` must be valid against the source artifact at runtime.
- `required: true` fails the step if the source path is absent.
- Large context is clipped by policy and recorded in source metadata.

## 5. Step Context

Before executing a node, runtime builds a `StepContext`:

```ts
interface StepContext {
  run_id: string;
  step_id: string;
  inputs: Record<string, JsonValue>;
  sources: Array<{
    alias: string;
    from_step: string;
    output_path: string;
    selected_path: string;
    required: boolean;
    clipped: boolean;
    original_bytes: number;
    selected_bytes: number;
  }>;
}
```

Backend signature changes from:

```ts
executeStep(node)
```

to:

```ts
executeStep(node, context)
```

Agent backends receive:

- `node.input.prompt`
- selected context aliases
- source metadata
- output schema
- permission profile

The current backend records selected context aliases and source metadata in `agent.*` artifacts. `command.collect` is the default command shape for evidence gathering, while strict `command.verify` remains command-driven for tests, build, lint, and final acceptance. Command templating from context is not implemented.

## 6. Produces

Every step already writes `steps/<step_id>.json`. The next version should let authors declare stable output contracts:

```js
const docs = command("collect_docs", {
  run: ["sed -n '1,220p' README.md"],
  produces: {
    checks: "$.output.collection.checks",
  },
});
```

Compiled form:

```json
{
  "produces": {
    "checks": {
      "select": "$.output.collection.checks",
      "schema": "command_collection/v1"
    }
  }
}
```

Downstream refs can use either full JSONPath or named outputs:

```js
docs.produces("checks")
docs.output("$.output.collection.checks[*].stdout")
```

## 7. Agent Step Semantics

The current backend still marks `agent.*` steps as generic succeeded results, but it now records explicit consumed context in artifacts. Real external agent adapters remain future work.

Target behavior for future external adapters:

- `agent.review` consumes explicit context and returns structured findings.
- `agent.synthesize` consumes explicit findings/artifacts and returns a final structured summary.
- `agent.execute` consumes prior diagnosis/review/context and writes implementation artifacts.
- `agent.classify` returns a label object used by `run_if` or JS branch capture.
- `agent.judge_pair` consumes candidate refs and returns a winner ref plus rationale.

Each agent step must declare:

```js
agent.review("review", {
  context: { docs: docs.output("...") },
  outputSchema: "review_findings/v1",
  permissionProfile: "reviewer_readonly",
});
```

Prompt text cannot grant extra permissions.

## 8. Branches, Loops, And Tournaments

JS authoring should eventually make complex patterns natural. Current implemented JS capture is limited to declarative step calls and context refs; the following branch/loop/tournament JS examples are future design examples, while typed YAML/JSON control steps are executable today. YAML `workflow.loop` already supports body subgraphs, `$previous` feedback, and `until` short-circuiting; the JS helper shown below is the planned authoring shorthand for that executable IR.

```js
const label = agent.classify("classify", {
  prompt: "Classify as bugfix, feature, or research.",
});

when(label.output("$.output.label").eq("bugfix"), () => {
  bugfixFlow({ request: label.output("$.output") });
});
```

Loop:

```js
const result = loop("repair", { maxRounds: 3 }, ({ round, previous }) => {
  const fix = agent.execute(`fix_${round}`, {
    context: { previous },
  });
  return command(`verify_${round}`, {
    run: ["npm test"],
    after: fix,
  });
});
```

Tournament:

```js
const winner = tournament("choose_design", candidates, {
  criteria: ["correctness", "risk", "implementation cost"],
});
```

The future captured manifest will expand these into concrete nodes and explicit `consumes` edges.

## 9. Safety Boundary

Do not directly run arbitrary JS with Node permissions.

Allowed:

- Workflow SDK calls.
- JSON manipulation.
- Local variables and pure composition.
- Artifact refs.

Denied:

- `fs`, `child_process`, `process`, `process.env`.
- `fetch`, network, sockets.
- `require`, dynamic `import`.
- `eval`, `Function`, global escape.
- Template expressions that execute arbitrary JS in unsafe capture modes.

All side effects go through typed workflow SDK calls and permission profiles.

## 10. Resume Semantics

Resume does not resume JS call stack.

On resume:

1. Load `compiled_manifest.json`.
2. Load `run.json`.
3. For succeeded nodes, reuse `steps/<step_id>.json`.
4. For queued nodes, rebuild `StepContext` from declared `consumes`.
5. Continue scheduling from manifest readiness.

If `workflow.js` changes, create a new run unless the user explicitly requests a migration.

## 11. Migration Path

### Implemented: Dataflow IR

- Add `consumes` and `produces` to types, validation, compiler, manifest, and docs.
- Add `StepContext` construction from step artifacts.
- Keep YAML/JSON authoring working.

### Implemented: Context Injection

- Change backend interface to `executeStep(node, context)`.
- Make `agent.*` artifacts record the consumed aliases.
- Add tests proving downstream steps receive upstream command output.

### Implemented: JS DSL Capture

- Add `workflow.js` authoring capture for `command`, `agent.review`, `agent.synthesize`, and `agent.execute`.
- `StepHandle.output()` creates `ArtifactRef`.
- Compile captured graph to manifest v2.

### Deferred: Real Agent Adapter

- Replace fake `agent.*` success with a host or Paseo/Codex adapter.
- Validate structured outputs.
- Enforce permission profiles.

### Implemented: YAML Control Dataflow

- `workflow.include`, `workflow.tournament`, and `workflow.loop` compile to concrete manifest nodes.
- `workflow.loop` can expand a body subgraph per round, rewrite `$previous` to the prior terminal step, and skip later rounds with `input.until`.

### Deferred: Full JS Control Capture

- Branch callbacks, loop callbacks, tournament helpers, and `when(...)` capture are not implemented yet.
- YAML/JSON remains supported as typed IR import/export and as the direct CLI surface.

## 12. Compatibility

Existing `dynamic_workflow/run/v1` plans keep working.

Compatibility behavior:

- If `consumes` is absent, runtime behaves like current MVP.
- `run_if` continues reading from step artifacts.
- YAML `depends_on` remains valid but no longer implies data injection.
- New examples should prefer explicit dataflow refs.

The key product contract:

```text
Workflow value comes from explicit artifact handoff, not just execution order.
```
