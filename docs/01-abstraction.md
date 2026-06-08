# Dynamic Workflow 抽象

## 1. 核心定义

Dynamic workflow 是一种由 agent 为当前复杂任务临时生成或选择的执行 harness。

它解决的问题不是“模型不会做”，而是“单个上下文同时承担规划、执行、验证、汇总时容易失控”。

典型失败包括：

- 任务列表很长，agent 提前宣布完成。
- agent 审核自己产物，默认自己正确。
- 多轮压缩后早期约束丢失。
- 读不可信输入的 agent 同时拥有高权限工具。
- 一个失败步骤没有被记录，后续步骤继续跑偏。

Dynamic workflow 通过结构化分工降低这些风险。

## 2. 运行时组成

一套完整 runtime 通常包含这些组件：

```text
Workflow Generator / Planner
  生成 workflow.js 或 typed plan

Workflow Runtime / Host
  校验、执行、调度、记录 trace

JS Sandbox
  只执行 workflow orchestration，不直接访问系统资源

Subagent Runtime
  启动独立上下文 agent，配置 model/tools/prompt/budget

Artifact Store
  保存 plan、subagent outputs、review results、logs、trace

Verifier / Judge
  独立检查执行结果

Synthesizer
  合并输出、去重、处理冲突、给最终结论
```

## 3. JS Harness 可能怎么工作

JS 不是业务逻辑本身，而是 workflow DSL 的宿主语言。模型可以生成类似：

```js
const results = await parallel([
  agent("review gateway code", { tools: ["read_only"] }),
  agent("review group app runtime", { tools: ["read_only"] }),
  agent("review UI entry update flow", { tools: ["read_only"] }),
])

return await agent("synthesize findings", {
  role: "synthesizer",
  input: results,
})
```

这里真正重要的是 runtime 提供的受控 SDK：

- `agent(prompt, options)`：启动独立 subagent。
- `parallel(tasks)`：并行执行。
- `pipeline(stages)`：串行阶段。
- `loop(step, stopCondition, budget)`：有限循环。
- `judge(candidates, criteria)`：比较候选。
- `artifact.write/read`：保存结构化中间产物。

JS harness 的隔离边界应当是：脚本只拥有这些 workflow primitives，不拥有 `fs`、`child_process`、`process.env`、网络请求或动态 import。真正的系统副作用只能通过 `agent()` 调起的受控 agent/tool 通道发生。

## 4. 权限边界

Dynamic workflow 必须把权限当成一等对象。

```text
不可信输入读取 agent
  tools: read_only
  output: sanitized summary

高权限执行 agent
  tools: filesystem / terminal
  input: sanitized summary

reviewer agent
  tools: read_only
  role: adversarial verifier
```

这体现最小权限原则：读和做分开，执行和审核分开。

## 5. 结构化输出

Subagent 输出最好使用结构化 contract，否则 fan-out 后很难汇总。

```json
{
  "status": "done",
  "summary": "checked group app runtime",
  "findings": [
    {
      "severity": "high",
      "file": "src/runtime/task_runtime.py",
      "reason": "..."
    }
  ],
  "confidence": "high",
  "open_questions": []
}
```

Runtime 可以校验 schema。校验失败时让 subagent 修复输出，而不是把自由文本直接交给 synthesizer。

## 6. Trace 与可恢复

Dynamic workflow 如果没有 trace，很难调试。

建议保存：

```text
workflow_runs/{run_id}/
  workflow.js 或 plan.yaml
  trace.json
  agents/{agent_id}/input.json
  agents/{agent_id}/output.json
  agents/{agent_id}/messages.json
  artifacts/**
```

Trace 至少包含：

- 每个 subagent 的目标。
- 使用的 model/tools/budget。
- 输入和输出。
- 状态变化。
- reviewer 结论。
- 错误和重试。

## 7. 两种实现路线

### Claude-style JS Workflow

适合开发者本地任务：

- 任务开放。
- 工具权限由开发者承担风险。
- 需要快速探索不同 harness。
- 可以容忍一次性 workflow script。

优点：表达力强，容易组合复杂模式。
风险：权限、恢复、审计和产品化稳定性更难。

该路线必须额外具备 JS sandbox、agent backend adapter、permission profile 和 trace store。否则脚本会从“编排层”退化成“任意代码执行层”。

### Product-style Typed Workflow

适合产品运行时：

- 用户是普通业务用户。
- 需要审计和恢复。
- 有明确事实源。
- 不允许任意脚本执行。

优点：安全、可测、可恢复。
风险：表达力受 step type 限制，需要逐步扩展。
