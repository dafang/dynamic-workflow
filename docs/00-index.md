# Dynamic Workflow Harness

这组文档整理我们关于 dynamic workflow 的讨论，目标不是描述某个具体产品的内部实现，而是沉淀一套可给 Codex / Claude 这类 agent 使用的通用抽象方案。

核心判断：

- dynamic workflow 的价值不在“多开 agent”，而在为复杂任务临时生成一套更合适的 harness。
- harness 负责结构：如何拆任务、哪些 subagent 干活、哪些 subagent 审核、结果如何汇总、失败如何停止。
- JS 这类语言适合作为 workflow authoring DSL，但不能直接拥有系统能力。
- 产品运行时应执行 manifest IR 和 artifact dataflow，而不是依赖 JS call stack 或聊天上下文。

## 文档列表

- [01-abstraction.md](./01-abstraction.md)：dynamic workflow 的通用抽象、运行时组成和权限边界。
- [02-patterns.md](./02-patterns.md)：文章提到的几种 workflow 模式如何实现。
- [03-general-implementation-gaps.md](./03-general-implementation-gaps.md)：如果实现成通用 dynamic workflow 方案，架构与落地还缺什么。
- [04-js-runtime-and-agent-bridge.md](./04-js-runtime-and-agent-bridge.md)：JS runtime 如何隔离执行，以及 `agent()` 如何桥接 Codex / Claude / ACP。
- [05-skills-and-slash-commands.md](./05-skills-and-slash-commands.md)：如何把 dynamic workflow 包装成给 Codex / Claude 使用的 skills 与 slash commands。
- [06-typed-plan-runtime.md](./06-typed-plan-runtime.md)：typed plan 如何表达 dynamic workflow 模式，以及如何稳定驱动 agent 执行。
- [07-js-first-dataflow-runtime.md](./07-js-first-dataflow-runtime.md)：下一阶段的 JS-first authoring、manifest IR、artifact dataflow 和上下文注入设计。
- [samples/js-harness-pseudocode.js](./samples/js-harness-pseudocode.js)：Claude-style JS harness 伪代码。
- [samples/typed-plan.yaml](./samples/typed-plan.yaml)：Product-style typed workflow plan 示例。

## 一句话版本

Claude-style dynamic workflow:

```text
主 Agent 生成 workflow.js
  -> JS sandbox 执行受控 SDK
  -> SDK 调 Workflow Host
  -> Host 经 Agent Adapter / ACP 启动 subagents
  -> artifact store 记录 trace
  -> synthesizer 汇总
```

JS-first dataflow dynamic workflow:

```text
User-facing Agent 或 Planner 生成 workflow.js
  -> SDK capture graph and artifact refs
  -> Host 生成 compiled manifest IR
  -> Runtime 按 manifest 调度并注入 StepContext
  -> artifacts / trace 支持 review、resume、summarize
```

## 适用判断

适合 dynamic workflow：

- 任务长，单上下文容易遗漏。
- 子任务能拆分。
- 需要独立 reviewer 降低自我偏袒。
- 需要并行分析或并行构建。
- 需要循环修复直到满足停止条件。
- 需要把“不可信输入读取”和“高权限执行”隔离。

不适合 dynamic workflow：

- 简单单步任务。
- 验证成本低于编排成本。
- 子任务无法拆分。
- 需要低延迟、低 token 消耗。
- 业务运行时不允许动态脚本或动态权限。
