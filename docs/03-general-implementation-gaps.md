# 通用 Dynamic Workflow 落地缺口

如果把 dynamic workflow 做成一套通用 agent harness，而不是某个业务系统里的专用流程，核心难点不在“能不能启动多个 agent”，而在下面这些基础能力是否齐全。

## 1. Workflow Runtime

需要一套持久化 runtime，而不是只在当前对话里保存计划。

最低要求：

- workflow run id。
- 原始用户请求。
- 已确认 plan。
- step 状态。
- step 输入/输出引用。
- agent/subagent session 引用。
- 错误和重试记录。
- created/updated timestamps。

典型状态机：

```text
draft -> validated -> running -> completed
                    -> failed
                    -> waiting_user
                    -> cancelled
                    -> partial_succeeded
```

关键约束：

- plan 一旦 validated 并开始执行，应作为审计事实保存。
- 后续执行更新 step result/event，不应悄悄改写 plan。
- 如果确实需要改 plan，应进入显式 revision 流程。

## 2. Step Type Registry

通用方案必须有 step type registry。

每个 step type 至少定义：

```yaml
type: code.review
input_schema: ...
output_schema: ...
allowed_tools: [read_file, search_files]
permission_level: read_only
retry_policy: ...
timeout: ...
```

没有 registry 的动态 workflow 很容易退化成“模型想执行什么就执行什么”。

Registry 要解决：

- 哪些 step type 可用。
- 输入输出 schema。
- 需要哪些工具权限。
- 是否可并发。
- 是否可重试。
- 是否允许访问不可信输入。
- 是否允许写文件、跑命令、调用外部 API。

typed plan 要能表达 dynamic workflow 的几种模式，registry 里除了普通 agent step，还需要控制型 step type，例如 `workflow.include`、`workflow.loop`、`workflow.tournament`、`agent.synthesize`、`human.approval`。这些不是交给 agent 自由解释，而是由 runtime 编译成可执行 DAG 或状态机。

## 3. Planner 与 Host 校验分离

Planner 可以是 LLM，但 Host 校验必须是确定性的。

```text
Planner:
  根据用户请求生成 plan

Host:
  校验 plan schema
  校验 step type
  校验 dependency
  校验权限
  校验预算
  校验资源边界
```

不能让 planner 自己决定“这个计划是安全的”。

Host 校验失败时，应返回结构化错误：

```json
{
  "code": "unsupported_step_type",
  "step_id": "run_shell",
  "reason": "shell.run is not allowed in this workflow profile"
}
```

## 4. Subagent Isolation

通用 dynamic workflow 需要真正的 subagent isolation。

至少包括：

- 独立 conversation context。
- 独立 tool allowlist。
- 独立 model / budget。
- 独立 artifact scope。
- 可选独立 worktree / sandbox。

隔离目标：

- 执行者和 reviewer 分离。
- 读不可信输入和高权限执行分离。
- 并行分支互不污染。
- 一个 subagent 的失败不自动污染全局上下文。

## 5. Artifact Store

所有中间产物都应进入 artifact store。

包括：

- plan。
- subagent prompt。
- subagent structured output。
- reviewer output。
- 文件 diff。
- 测试结果。
- 外部 API 响应摘要。
-最终 summary。

Artifact store 的价值：

- 汇总阶段有稳定输入。
- 失败后可恢复。
- review 可以读结构化产物，而不是翻完整聊天。
- 用户可以追溯“为什么得出这个结论”。

## 6. Structured Output Contract

Subagent 输出不能只靠自由文本。

每个 step type 应有 output contract。例如：

```json
{
  "status": "succeeded",
  "summary": "Reviewed gateway code",
  "findings": [],
  "artifacts": [],
  "confidence": "high",
  "open_questions": []
}
```

Runtime 需要处理：

- schema 校验失败。
- subagent 输出不完整。
- subagent 声称完成但 artifact 缺失。
- reviewer 与 executor 结论冲突。

## 7. Permission Model

需要 profile 级权限模型。

示例：

```yaml
profiles:
  research:
    allowed_tools: [web_search, read_file]
    write: false
    shell: false

  code_write:
    allowed_tools: [read_file, write_file, run_tests]
    write: true
    shell: limited

  reviewer:
    allowed_tools: [read_file, search_files]
    write: false
    shell: false
```

关键点：

- 权限绑定到 step type / role，而不是由 agent 临场决定。
- 不可信输入读取 step 不应拥有写权限。
- 高权限 step 只接收清洗后的结构化输入。

## 8. Scheduler 与 Concurrency Control

Dynamic workflow 需要 scheduler。

Scheduler 负责：

- 根据 dependency 启动 ready steps。
- 控制并发数。
- 控制同类资源冲突。
- 处理 timeout。
- 处理 cancellation。
- 处理重试。

并发不是简单 `Promise.all`。需要考虑：

- 同一个文件不能被多个 writer 同时改。
- 同一个 project/runtime scope 可能只能同时跑一个 UI build。
- reviewer 必须等 executor output 完成。
- fan-out 分支失败后是否继续其他分支。

稳定性来自 scheduler 驱动，而不是 agent 自己“记得下一步”。Runtime 每次只把 ready step 交给 agent；step 结束后校验 output schema 和 verify 条件，再决定是否推进下游步骤。

## 9. Recovery 与 Resume

通用方案必须回答：进程挂了怎么办？

最低要求：

- status 可读。
- terminal state 不丢。
- running step 能标记 stale / interrupted。
- 用户能重试或取消。

更完整的能力：

- 从上次 completed step 后继续。
- 恢复 subagent session。
- 重放未完成 step。
- 按 idempotency key 避免重复副作用。

## 10. Budget 与 Stop Condition

Dynamic workflow 很容易失控。

需要预算：

- max steps。
- max subagents。
- max rounds。
- max tokens。
- max wall time。
- max retries。

每个 loop 必须有 stop condition：

```text
done == true
or max_rounds reached
or no new findings
or all tests pass
or user approval required
```

没有预算和停止条件的 dynamic workflow 不应进入产品运行时。

## 11. Human-in-the-loop

复杂 workflow 经常需要人确认：

- 计划不确定。
- 高风险写入。
- 多个方案都可行。
- 验证失败但可以继续。
- 预算即将耗尽。

需要一等 HIL step：

```yaml
type: human.approval
prompt: "是否继续执行修复？"
resume_policy:
  on_approve: continue
  on_reject: cancel
```

HIL 的用户回复也要进入 workflow runtime，而不是只留在聊天里。

## 12. Observability

需要能回答：

- 当前 workflow 卡在哪一步？
- 哪个 subagent 失败？
- 为什么失败？
- 哪个 reviewer 否决了结果？
- 哪些 artifact 被用于最终汇总？
- 这次执行花了多少 token / 时间？

建议事件：

```text
workflow_created
workflow_validated
step_queued
step_started
step_succeeded
step_failed
step_blocked
review_started
review_failed
workflow_completed
workflow_cancelled
```

## 13. User-facing Summary

Dynamic workflow 内部可能很复杂，但用户不应看到完整 trace。

面向用户的 summary 应包含：

- 做了什么。
- 哪些步骤完成。
- 哪些失败。
- 需要用户做什么。
- 可点击/可查询的状态入口。

不应包含：

- 内部 prompt。
- token。
- 本地路径。
- secret。
- 不必要的 tool/debug 信息。

## 14. Script Workflow 与 Typed Workflow 的取舍

### Script Workflow

适合：

- 本地开发者工具。
- 一次性复杂任务。
- 探索性强。
- 用户能承担脚本权限风险。

需要：

- sandbox。
- SDK allowlist。
- script audit。
- runtime trace。
- agent backend bridge。

脚本执行层必须和 agent 执行层分开：JS script 只调 workflow SDK，SDK 再通过 Workflow Host / Agent Adapter / ACP 或原生 CLI/API 启动真实 subagent。不要让脚本直接拥有文件、shell、网络或 secret 权限。

### Typed Workflow

适合：

- 产品运行时。
- 普通业务用户。
- 强审计和恢复。
- 权限边界清晰。

需要：

- step type registry。
- deterministic host validation。
- durable runtime state。
- explicit permissions。

## 15. 最小可行架构

一个通用 MVP 可以从这里开始：

```text
WorkflowPlan
WorkflowRunStore
StepTypeRegistry
WorkflowHost
SubagentRunner
ArtifactStore
WorkflowStatus API
```

第一批模式：

- `pipeline`
- `parallel`
- `adversarial_review`
- `loop_until_done` with max_rounds

第一批 step role：

- `classifier`
- `executor`
- `reviewer`
- `synthesizer`
- `human_approval`

第一批硬约束：

- no arbitrary script execution by default
- plan immutable after validation
- all subagent outputs structured
- all writes go through declared step permissions
- all workflow runs durable and queryable
- JS sandbox does not expose fs/shell/env/network
- agent backend permissions must be enforced or the step must be rejected
