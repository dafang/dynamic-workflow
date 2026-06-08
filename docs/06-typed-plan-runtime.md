# Typed Plan Runtime

本文回答两个问题：

1. typed plan 如何表达 dynamic workflow 的几种模式。
2. typed plan 如何稳定驱动 agent 推进，而不是退化成“给 agent 一份 YAML 让它自觉执行”。

结论：

- typed plan 足够表达常见 dynamic workflow 模式。
- 稳定性不来自 YAML 本身，而来自 validator、compiler、scheduler、structured output、trace 和 final audit。
- typed plan 必须由 runtime/scripts 驱动；不能只作为 prompt 说明。

## 1. 基本结构

一个通用 typed plan 至少需要：

```yaml
schema_version: dynamic_workflow/run/v1
workflow_id: dwf_001
kind: mixed
budget:
  max_steps: 20
  max_subagents: 8
  max_rounds: 3
steps:
  - step_id: review_auth
    type: agent.review
    permission_profile: reviewer_readonly
    input:
      prompt: "Review auth module"
    depends_on: []
```

核心字段：

```yaml
step_id: string
type: string
input: object
depends_on: string[]
permission_profile: string
budget: object
run_if: condition
strategy: optional string
verify: optional object
```

## 2. Fan-out and Synthesize

多个分支无依赖，可以并行；汇总 step 依赖所有分支。

```yaml
steps:
  - step_id: review_gateway
    type: agent.review
    strategy: fanout_branch
    input:
      prompt: "Review gateway module"
    depends_on: []

  - step_id: review_runtime
    type: agent.review
    strategy: fanout_branch
    input:
      prompt: "Review runtime module"
    depends_on: []

  - step_id: synthesize
    type: agent.synthesize
    input:
      prompt: "Merge findings and remove duplicates"
      from_steps: [review_gateway, review_runtime]
    depends_on: [review_gateway, review_runtime]
```

Runtime 看到 `review_gateway` / `review_runtime` 都 ready，就可以并行执行。`synthesize` 等它们都完成。

## 3. Adversarial Verification

执行 step 后接 reviewer step。Reviewer 只能读 executor output。

```yaml
steps:
  - step_id: implement_feature
    type: agent.execute
    permission_profile: writer
    input:
      prompt: "Implement the requested feature"
    depends_on: []

  - step_id: review_feature
    type: agent.review
    permission_profile: reviewer_readonly
    input:
      prompt: "Find bugs, missing tests, unsafe assumptions"
      review_target: implement_feature
    depends_on: [implement_feature]

  - step_id: fix_review_findings
    type: agent.execute
    permission_profile: writer
    run_if:
      step: review_feature
      output_path: "blocking.length"
      op: ">"
      value: 0
    input:
      prompt: "Fix blocking review findings"
      from_steps: [implement_feature, review_feature]
    depends_on: [review_feature]
```

`run_if` 让 plan 能表达条件执行。Reviewer 没发现 blocking 时，fix step 自动 skipped。
`output_path` 相对于 step artifact 里的 `output` 对象，例如 `status` 会读取该 step 输出的状态字段。

## 4. Classify and Act

先分类，再根据分类结果跑不同分支。

```yaml
steps:
  - step_id: classify
    type: agent.classify
    input:
      prompt: "Classify request"
      labels: [bugfix, feature, research]
    depends_on: []

  - step_id: bugfix_flow
    type: workflow.include
    workflow_ref: builtin.bugfix
    run_if:
      step: classify
      output_path: "label"
      op: "=="
      value: "bugfix"
    depends_on: [classify]

  - step_id: feature_flow
    type: workflow.include
    workflow_ref: builtin.feature
    run_if:
      step: classify
      output_path: "label"
      op: "=="
      value: "feature"
    depends_on: [classify]
```

Runtime 不需要 JS `switch`，只需要支持 `run_if` 和 `workflow.include`。

## 5. Generate and Filter

多个 generator 产出候选，filter step 根据 criteria 排序/选择。

```yaml
steps:
  - step_id: generate_conservative
    type: agent.generate
    input:
      prompt: "Generate conservative architecture option"
    depends_on: []

  - step_id: generate_aggressive
    type: agent.generate
    input:
      prompt: "Generate aggressive architecture option"
    depends_on: []

  - step_id: filter_options
    type: agent.filter
    input:
      criteria: [correctness, cost, maintainability]
      candidates:
        - from_step: generate_conservative
        - from_step: generate_aggressive
    depends_on:
      - generate_conservative
      - generate_aggressive
```

## 6. Tournament

Tournament 可以显式列 pair，也可以由控制型 step 编译展开。

显式版：

```yaml
steps:
  - step_id: candidate_a
    type: agent.generate
    depends_on: []

  - step_id: candidate_b
    type: agent.generate
    depends_on: []

  - step_id: candidate_c
    type: agent.generate
    depends_on: []

  - step_id: judge_ab
    type: agent.judge_pair
    input:
      candidate_a: candidate_a
      candidate_b: candidate_b
      criteria: [correctness, complexity, risk]
    depends_on: [candidate_a, candidate_b]

  - step_id: judge_final
    type: agent.judge_pair
    input:
      candidate_a:
        from_step: judge_ab
        output_path: "winner"
      candidate_b: candidate_c
    depends_on: [judge_ab, candidate_c]
```

抽象版：

```yaml
steps:
  - step_id: tournament
    type: workflow.tournament
    input:
      candidate_steps: [candidate_a, candidate_b, candidate_c]
      judge_type: agent.judge_pair
      criteria: [correctness, complexity, risk]
    depends_on: [candidate_a, candidate_b, candidate_c]
```

Runtime 编译 `workflow.tournament` 成多个 `agent.judge_pair` step。
下游 step 可以直接 `depends_on: [tournament]`；compiler 会把这个依赖改写到最后一个 judge 节点。

## 7. Loop Until Done

Loop 用控制型 step 表达，不使用 JS `while`。

```yaml
steps:
  - step_id: debug_loop
    type: workflow.loop
    input:
      max_rounds: 3
      body:
        - step_id: diagnose
          type: agent.debug
          input:
            prompt: "Diagnose current failure"

        - step_id: fix
          type: agent.execute
          permission_profile: writer
          input:
            prompt: "Apply focused fix"

        - step_id: verify
          type: command.verify
          verify:
            commands: ["npm test"]

      stop_condition:
        step: verify
        output_path: "exit_code"
        op: "=="
        value: 0
    depends_on: []
```

Runtime 展开：

```text
debug_loop.round_1.diagnose
debug_loop.round_1.fix
debug_loop.round_1.verify
if stop false:
  debug_loop.round_2...
```

硬约束：所有 loop 必须有 `max_rounds` 和 `stop_condition`。
下游 step 可以直接 `depends_on: [debug_loop]`；compiler 会把这个依赖改写到最后一轮节点。

## 8. Runtime 如何保证稳定推进

如果只是把 YAML 给 agent：

```text
这里有个 plan，你照着做
```

那不稳定。Agent 可能漏步骤、跳步骤、提前总结、忘记验证。

稳定性来自 runtime/scripts：

```text
typed plan
  -> validate
  -> compile DAG
  -> schedule ready step
  -> run step through agent backend
  -> validate structured output
  -> run verify
  -> write trace
  -> advance state
  -> final audit
```

## 9. Validator

Validator 是第一道防线。

必须校验：

- schema version。
- step_id 唯一。
- step type 已注册。
- depends_on 都存在且无环。
- run_if 只引用已存在的 step。
- workflow.include 只能引用允许模板。
- workflow.loop 必须有 max_rounds 和 stop_condition。
- permission_profile 存在且适配 step type。
- budget 存在且不超过上限。

校验失败时不执行。

## 10. Compiler

Compiler 把 typed plan 转成可执行图。

职责：

- 生成 DAG。
- 展开 `workflow.include`。
- 展开 `workflow.tournament`。
- 准备 `workflow.loop` 的 round state。
- 将指向控制型 step 的 `depends_on` 和 `run_if.step` 改写到展开后的终点节点。
- 校验编译后的 manifest 不包含悬空依赖或悬空条件引用。
- 计算 resource locks。
- 生成 ready queue。

输出：

```text
compiled_manifest.json
```

## 11. Scheduler

Scheduler 每次只把 ready step 交给 agent。

```text
step A depends_on: []
step B depends_on: [A]
step C depends_on: [A, B]
```

运行时：

```text
run A
validate A output
verify A
mark A succeeded
run B
...
```

Agent 不能自己跳到后面的 step，因为它一次只收到当前 step。

## 12. Structured Output

Step 不能只输出“我做完了”。

最小输出：

```json
{
  "status": "succeeded",
  "summary": "...",
  "artifacts": [],
  "findings": [],
  "next_actions": []
}
```

Runtime 校验 output schema。不合格不能标记 step done。

## 13. Verify

Step 完成后必须有 verify。

示例：

```yaml
verify:
  type: command
  commands:
    - npm test
```

或：

```yaml
verify:
  type: agent.review
  permission_profile: reviewer_readonly
```

没有 verify 通过，step 不进入 `succeeded`。

## 14. State Machine

每个 step 都有明确状态：

```text
queued -> running -> succeeded
                  -> failed
                  -> blocked
                  -> skipped
                  -> waiting_user
```

失败时：

- 下游依赖 step 自动 `blocked`。
- workflow 不继续执行依赖链。
- status 能报告卡点。

## 15. Trace Store

每一步都落盘：

```text
.dynamic-workflow/runs/<run_id>/
  plan.yaml
  compiled_manifest.json
  trace.jsonl
  steps/<step_id>.json
  artifacts/**
```

这样推进不依赖聊天上下文。

## 16. Transcript Markers

执行时输出：

```text
DW_STEP_START
DW_STEP_VERIFY
DW_STEP_DONE
DW_RUN_COMPLETE
```

这让宿主 `/goal` evaluator 和人都能判断是否真的推进过。

## 17. Final Audit

最后不是 agent 说“都完成了”就结束。

Final audit 要核对：

- 每个 step 是否 terminal。
- 每个 required verify 是否通过。
- 每个 artifact 是否存在。
- 是否还有 failed / blocked / waiting_user。
- 是否违反 permission / scope。

只有 audit 通过才打印：

```text
DW_RUN_COMPLETE
```

## 18. 一句话总结

typed plan 足够驱动 dynamic workflow，但前提是它被 runtime 执行。

```text
typed plan + deterministic scripts + trace + verifier
```

才是 workflow harness。

单独一份 YAML 只是更长的 prompt。
