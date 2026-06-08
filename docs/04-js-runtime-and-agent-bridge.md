# JS Runtime Sandbox 与 Agent Bridge

本文聚焦两个问题：

1. JS workflow script 如何隔离运行。
2. JS 里的 `agent()` 如何桥接到 Codex / Claude / 其他 agent runtime。

结论：

- JS sandbox 负责把 workflow script 限制为“编排层”。
- Agent bridge 负责把 `agent()` 转成真实 agent backend 调用。
- ACP 可以作为 agent backend 的标准桥接协议，但 ACP 不负责 JS sandbox，也不负责 workflow 状态机。

## 1. 分层架构

```text
workflow.js
  -> JS Sandbox
      only exposes workflow SDK:
        agent()
        parallel()
        pipeline()
        loop()
        judge()
        artifact.read/write()
        askUser()
  -> Workflow Host
      validates permissions, budget, concurrency, trace
  -> Agent Adapter Layer
      maps agent() to backend-specific calls
  -> ACP Client or Native CLI/API Adapter
      Codex / Claude / Gemini / local agent runtime
  -> Artifact Store + Trace Store
```

这几个层不能混在一起：

- JS sandbox 只解决脚本隔离。
- Workflow Host 解决计划、状态、预算、并发和权限。
- Agent Adapter 解决后端差异。
- ACP 解决和外部 agent runtime 的协议通信。

## 2. JS Sandbox 应该禁止什么

workflow.js 不应直接拥有系统能力。

禁止：

```text
fs / file system
child_process / shell
process.env
net / http / fetch
dynamic import / require
eval / new Function
global escape
native addon
```

允许：

```text
JSON
Math
Array/Object/String/Number
Promise
structuredClone
workflow SDK
limited timers if needed
```

关键原则：

```text
JS 可以决定“下一步调哪个 agent”
JS 不可以自己读文件、写文件、跑命令或访问 secret
```

系统副作用只能从受控 `agent()` 或其他 typed SDK call 发生。

## 3. 三档 Sandbox 实现

### 3.1 轻量本地工具档

可选技术：

- Node `vm`
- SES / lockdown
- isolated-vm
- Deno permissions

适合：

- 本地开发者工具。
- 用户信任 workflow script。
- 风险主要来自误操作而非对抗性攻击。

注意：Node `vm` 不是完整安全边界，不能拿它承诺能执行恶意脚本。必须确保没有暴露 `require`、`process`、host object escape。

### 3.2 产品运行时档

可选技术：

- Deno + deny all permissions by default。
- 容器 sandbox。
- gVisor / Firecracker。
- WebAssembly runtime for DSL-like execution。

适合：

- 普通用户触发。
- 脚本由模型生成。
- 需要更强隔离和审计。

建议：

- 默认无网络。
- 默认无文件系统。
- 只通过 RPC 调 Workflow Host。
- Host 决定所有 side effect。

### 3.3 Typed Workflow 档

不执行 JS，只执行 typed plan。

适合：

- 产品核心路径。
- 合规/审计要求高。
- step type 稳定。

这是最稳的产品化路线，但表达力弱于 JS。

## 4. `agent()` 的语义

`agent()` 不是普通函数调用，而是一次受控 subagent execution。

输入：

```js
await agent("review auth module", {
  backend: "codex",
  role: "reviewer",
  tools: ["read_file", "search_files"],
  outputSchema: "review_findings",
  budget: { maxTokens: 20000, timeoutSeconds: 600 },
  isolation: { worktree: "read_only" }
})
```

Host 需要把它转成：

```text
SubagentRun
  backend: codex
  role: reviewer
  prompt: review auth module
  tool allowlist: read_file, search_files
  output schema: review_findings
  budget
  artifact scope
```

输出：

```json
{
  "status": "succeeded",
  "agent_run_id": "agrun_123",
  "backend": "codex",
  "summary": "...",
  "structured_output": {},
  "artifacts": [],
  "usage": {
    "tokens": 12345,
    "elapsed_ms": 42000
  }
}
```

## 5. Agent Adapter Layer

不同 backend 能力不同，不能让 workflow script 直接依赖某个 CLI。

建议抽象：

```text
AgentBackend
  startSession(options)
  sendPrompt(session, prompt, context)
  streamEvents(session)
  cancel(session)
  close(session)
```

可支持 backend：

- Codex via ACP adapter。
- Claude via ACP adapter。
- Native Claude Code CLI。
- Native Codex CLI。
- OpenAI / Anthropic direct API。
- Local specialized worker。

Workflow script 只看到：

```js
agent(prompt, { backend: "codex" })
```

不关心底层是 ACP、CLI 还是 API。

## 6. ACP 桥接

ACP 适合做外部 agent runtime 的桥。

```text
Workflow Host
  -> ACP Client
  -> codex-acp / claude-agent-acp / other ACP server
  -> Real agent runtime
```

ACP 的价值：

- 标准化 session。
- 标准化 prompt / event stream。
- 标准化 cancel。
- 让 Codex / Claude / 其他 agent 可以作为 backend 插拔。

ACP 不负责：

- JS sandbox。
- workflow plan 校验。
- step dependency。
- budget policy。
- artifact store。
- permission profile。

这些仍归 Workflow Host。

## 7. Permission Mapping

workflow 里的工具权限需要映射到 backend 能理解的权限。

示例：

```yaml
workflow_profile: reviewer
tools:
  - read_file
  - search_files
write: false
shell: false
network: false
```

映射到 Codex / Claude backend 时可能变成：

```text
allowed_tools = read-only file/search tools
approval_policy = deny writes
sandbox = read-only
system_prompt = reviewer role constraints
```

如果 backend 不支持某项约束，Host 必须拒绝该 step 或降级到更安全 backend，不能假装支持。

## 8. Artifact 与 Context 输入

Subagent 不应默认继承完整 workflow 上下文。

推荐输入方式：

```text
agent prompt
  + selected artifacts
  + selected prior outputs
  + role policy
  + tool permissions
```

这样可以避免：

- 上下文污染。
- secret 泄漏。
- 不可信输入直接进入高权限 agent。
- reviewer 被 executor 的完整推理链锚定。

## 9. JS Script 生命周期

建议保存：

```text
workflow_runs/{run_id}/
  workflow.js
  compiled_manifest.json
  trace.json
  agents/**
  artifacts/**
```

其中 `compiled_manifest.json` 是 Host 从 JS 执行中观察到的 step/subagent 调用记录，或从 typed plan 编译出的执行图。

如果 script 被用户修改后重跑：

- 创建新的 run id。
- 保留旧 run trace。
- 不复用旧 run 的 mutable state。
- 可选择复用已完成 artifact，但必须显式记录。

## 10. 恢复与暂停

JS runtime 本身的恢复不可靠，应该恢复 workflow state，而不是指望恢复 JS call stack。

更稳的设计：

```text
每次 agent()/parallel()/pipeline() 调用都记录为 step event
已完成 agent result 缓存到 artifact store
恢复时重新解释 workflow 或读取 compiled graph
已完成 step 返回 cached result
未完成 step 继续执行
```

## 11. 安全红线

通用 dynamic workflow runtime 不应允许：

- 模型生成 JS 后直接在 Node 全权限环境执行。
- JS 直接访问 host 文件系统或 secret。
- planner 自己决定权限提升。
- backend 不支持权限约束时继续执行高风险 step。
- subagent 输出未经 schema 校验直接进入高权限 step。
- workflow 没有 budget 和 stop condition。

## 12. 最小可行实现

MVP 可以这样分阶段：

1. **Typed plan runtime**
   - 不执行 JS。
   - 实现 workflow state、step registry、agent adapter、artifact store。

2. **ACP backend adapter**
   - 让 `agent()` 能调 Codex/Claude ACP。
   - 支持 stream、cancel、structured output validation。

3. **JS orchestration sandbox**
   - 只暴露 workflow SDK。
   - 禁止系统 API。
   - JS 调用转成 typed step events。

4. **Resume / cached result**
   - 已完成 agent result 可复用。
   - 未完成 step 可继续。

5. **Permission profiles**
   - reviewer / executor / synthesizer / classifier 分权。
   - 后端不支持权限时拒绝执行。

