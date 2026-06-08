# Skills 与 Slash Commands 落地方案

目标：把 dynamic workflow 做成 Codex / Claude 都能消费的“技能包 + 命令入口”，让 agent 不只读一段说明，而是能按稳定入口启动、规划、执行、验证和汇总 workflow。

## 1. 基本判断

Skills 和 slash commands 的角色不同：

```text
Skill
  长期可复用的指导材料：
    什么时候使用
    怎么分诊
    可用模式
    安全边界
    输出格式
    scripts / templates / examples

Slash Command
  明确的人机入口：
    /dw-plan
    /dw-run
    /dw-review
    /dw-status
    /dw-resume
```

Skill 让 agent “知道怎么做”；slash command 让用户 “稳定触发这件事”。

## 2. 推荐包结构

参考 Supergoal 的做法，公开仓库本身可以包含 README、CHANGELOG、测试和 Claude plugin manifest；真正分发给使用者的是 `skills/<name>/` 下的 payload。Codex 用户可以手动 copy 这个 payload，Claude Code 用户可以通过 plugin marketplace 安装。

```text
dynamic-workflow/
  .claude-plugin/
    plugin.json
    marketplace.json
  README.md
  CHANGELOG.md
  tests/
    validate-plan.test.sh
    runtime-trace.test.sh
  skills/
    dynamic-workflow/
      SKILL.md
      references/
        workflow-patterns.md
        permissions.md
        backend-adapters.md
        trace-format.md
        goal-format.md
      commands/
        dw-plan.md
        dw-run.md
        dw-review.md
        dw-status.md
        dw-resume.md
      scripts/
        validate-plan.ts
        compile-plan.ts
        run-workflow.ts
        run-step.ts
        run-agent.ts
        status.ts
        resume.ts
        summarize-trace.ts
      templates/
        plan.yaml
        STATE.md
        TRACE.jsonl
        PROTOCOL.md
        workflow-result.schema.json
        review-result.schema.json
      examples/
        fan-out-and-synthesize.md
        adversarial-verification.md
        loop-until-done.md
```

对使用者实际安装的是：

```text
skills/dynamic-workflow/
  SKILL.md
  references/**
  commands/**
  scripts/**
  templates/**
  examples/**
```

如果宿主只支持 `SKILL.md`，commands 可以作为 prompt snippets 放在 `commands/` 下，由 agent 根据 slash command 名称读取。

如果宿主支持插件或命令注册，则 `commands/` 可以被注册成真正的 slash commands。

## 2.1 Runtime 数据目录

Skill 包本身应该保持只读和可升级。每次运行产生的数据写到项目目录下的隐藏目录，类似 Supergoal 使用 `.supergoal/`。

推荐：

```text
.dynamic-workflow/
  STATE.md
  runs/
    dwf_20260608_001/
      plan.yaml
      compiled_manifest.json
      trace.jsonl
      summary.md
      steps/
        step-001.json
        step-002.json
      agents/
        agent-run-001.json
      artifacts/
        ...
```

环境变量：

```bash
export DW_DIR="${DW_DIR:-.dynamic-workflow}"
export DW_SKILL_DIR="<resolved skill payload dir>"
```

Skill 启动时先定位 skill directory：

```bash
DW_SKILL_DIR=$(dirname "$(ls -1 \
  "$HOME/.claude/skills/dynamic-workflow/SKILL.md" \
  "$HOME/.codex/skills/dynamic-workflow/SKILL.md" \
  "$PWD/.claude/skills/dynamic-workflow/SKILL.md" \
  "$PWD/.codex/skills/dynamic-workflow/SKILL.md" \
  2>/dev/null | head -n1)")
export DW_SKILL_DIR
export DW_DIR="${DW_DIR:-.dynamic-workflow}"
mkdir -p "$DW_DIR/runs"
```

## 3. Skill 主文件应该写什么

`SKILL.md` 不应该写成百科，而应该写成 agent 的操作规程。

建议结构：

```markdown
# Dynamic Workflow Skill

## When to Use

- 任务长，单 agent 容易遗漏
- 需要并行分析
- 需要独立 reviewer
- 需要 loop until done

## Do Not Use

- 简单单步任务
- 用户只想要直接回答
- 没有清晰 stop condition

## Required Flow

1. Classify request
2. Decide mode
3. Draft typed plan
4. Validate plan
5. Ask user approval if high-impact
6. Execute through runtime or approved scripts
7. Validate outputs
8. Summarize trace

## Safety Rules

- Do not execute arbitrary generated JS unless sandbox is available
- Do not grant write tools to reviewer
- Do not pass untrusted raw content into high-permission executor
- Do not continue loop without max rounds

## Output Contract

...
```

## 4. Slash Command 设计

### `/dw-plan <task>`

只做规划，不执行。

职责：

- 判断是否需要 dynamic workflow。
- 选择模式：fan-out、adversarial verification、classify-and-act、loop 等。
- 生成 typed plan。
- 调 `validate-plan`。
- 给用户 review。

输出：

```yaml
workflow_id: draft
mode: fan_out_and_synthesize
requires_approval: true
steps:
  - step_id: review_auth
    type: agent.review
```

### `/dw-run <plan-file | task>`

执行已确认 plan，或先 plan 再执行。

职责：

- 若输入是任务：先等价执行 `/dw-plan`。
- 若输入是文件：读取 plan。
- 校验 plan。
- 创建 run id。
- 执行 step。
- 写 trace / artifacts。

强约束：

- 没有通过校验的 plan 不能执行。
- 高权限 step 需要用户确认或权限 profile 允许。

### `/dw-review <run-id | artifact>`

对已有 workflow run 做独立审查。

职责：

- 读取 trace。
- 让 reviewer subagent 检查遗漏、错误、权限越界。
- 输出 findings。

适合：

- 代码改动后审查。
- 重要产物发布前审查。
- 检查 workflow 是否偷懒或漏项。

### `/dw-status [run-id]`

查询当前或指定 workflow 状态。

输出：

- running / completed / failed / blocked。
- 每个 step 状态。
- 当前卡点。
- 下一步建议。

### `/dw-resume <run-id>`

恢复未完成 workflow。

职责：

- 读取 trace。
- 已完成 step 使用 cached result。
- 未完成 step 继续执行。
- stale step 需要重新确认或重试。

## 5. Scripts 的职责

Skill 下的 scripts 不应该替代 agent 思考，而是承担确定性工作。

### `validate-plan.ts`

确定性校验：

- schema version。
- step_id 唯一。
- step type 存在。
- dependency 合法。
- permission profile 合法。
- budget 存在。
- loop 有 stop condition。

### `compile-plan.ts`

把 typed plan 编译成执行图：

```text
plan.yaml -> compiled_manifest.json
```

输出：

- DAG。
- ready queue。
- dependency map。
- resource lock map。

### `run-workflow.ts`

执行 workflow：

- 创建 run id。
- 写 initial trace。
- 调 scheduler。
- 调 `run-agent.ts`。
- 汇总 terminal state。

第一版可以先不做真正 subagent 后端，只把 step 编译成执行指令和 trace，并要求当前 agent 按 step 执行。这样依然有 durable plan、状态和审计。

### `run-step.ts`

执行一个 step：

- 读取 compiled manifest。
- 校验 step 当前是否 ready。
- 加 resource lock。
- 调 `run-agent.ts` 或返回 manual/current-agent 指令。
- 写 step result。
- 释放 resource lock。

### `run-agent.ts`

把 step 转成 backend 调用：

- Codex backend。
- Claude backend。
- ACP backend。
- local mock backend。

### `summarize-trace.ts`

从 trace 生成用户可读总结：

- 不暴露 prompt。
- 不暴露 secret。
- 不暴露本地路径。
- 只展示必要状态和产物摘要。

### `repo-state.sh` / `project-state.sh`

参考 Supergoal 的 `repo-state.sh`，dynamic workflow 也需要一个确定性状态比较脚本，用于 final audit 或 review：

- baseline ref。
- changed files。
- deliverable exists。
- added debug output。
- untracked artifacts。

这个脚本应该在 dispatch 时复制到 `.dynamic-workflow/`，保证运行期间使用的审计逻辑和当时 skill 版本一致。

## 6. Codex / Claude 适配层

### Codex

OpenAI Skills 是可复用工作流，可以包含 instructions、examples 和 code，并且官方说明 Skills 支持 Codex 和 API。落地时可以把这套目录作为 Agent Skills 包安装，让 Codex 在相关请求下自动使用，也可以通过用户显式输入 `/dw-plan` 这类命令触发。

Codex 侧建议：

- Skill 负责指导。
- scripts 负责确定性校验和 runner。
- 写操作仍走 Codex 自己的 approval / sandbox。
- 对 shell 运行使用严格 allowlist。

### Claude

Claude Code 的 commands 可以从会话里触发 workflow；官方命令表里也把部分命令标记为 Skill 或 Workflow，并说明 commands 可用于运行 workflow、管理 subagents、background sessions、worktrees 等。

Claude 侧建议：

- 把 `/dw-*` 设计成自定义 skill commands。
- 对复杂并行任务可以映射到 Claude 的 subagent / background / worktree 能力。
- 对 read-only review 使用 restricted tools。
- 对写入执行使用明确 permission profile。

### 分发方式

Claude Code：

```text
/plugin marketplace add <repo-url>
/plugin install dynamic-workflow@dynamic-workflow
/reload-plugins
```

需要仓库包含：

```json
{
  "name": "dynamic-workflow",
  "description": "...",
  "version": "0.1.0",
  "skills": "./skills/"
}
```

Codex：

```bash
mkdir -p ~/.codex/skills
git clone <repo-url> /tmp/dynamic-workflow
cp -R /tmp/dynamic-workflow/skills/dynamic-workflow ~/.codex/skills/dynamic-workflow
rm -rf /tmp/dynamic-workflow
```

Codex 没有 marketplace 时，更新就是重新 copy skill payload。

## 7. Skill + Slash Command 的运行路径

```text
User:
  /dw-run migrate auth module to new API

Agent:
  loads dynamic-workflow skill
  reads command prompt commands/dw-run.md
  locates DW_SKILL_DIR
  initializes .dynamic-workflow/
  drafts typed plan
  calls scripts/validate-plan.ts
  asks approval if needed
  calls scripts/run-workflow.ts

Runtime:
  creates run id
  writes plan / compiled_manifest / trace
  starts subagents through backend adapter, or emits current-agent step instructions in MVP
  writes step results / artifacts

Agent:
  reads summary
  reports status to user
```

## 7.1 Single `/goal` 可选执行模式

Supergoal 的一个关键实践是：planner 不直接执行所有 phase，而是生成磁盘上的 roadmap/spec/protocol，再交付一条 ready-to-paste `/goal`。Dynamic workflow 也可以采用这个模式，尤其适合 Codex / Claude 都支持 `/goal` 的场景。

```text
/dw-run <task>
  -> Stage 1 plan
  -> write .dynamic-workflow/runs/<run_id>/plan.yaml
  -> write .dynamic-workflow/runs/<run_id>/PROTOCOL.md
  -> print one /goal command
  -> user pastes /goal
  -> executing agent reads PROTOCOL.md and plan.yaml
  -> run until DW_RUN_COMPLETE
```

这种模式的好处：

- Slash command 必须由用户触发，符合宿主约束。
- 长 plan 放磁盘，不塞进 `/goal` 参数。
- 执行协议稳定，可跨 Claude / Codex。
- Host evaluator 只需要看 transcript markers。

建议 transcript markers：

```text
DW_RUN_START
DW_STEP_START
DW_STEP_VERIFY
DW_STEP_DONE
DW_REVIEW_START
DW_REVIEW_COMPLETE
DW_RUN_COMPLETE
DW_RUN_HANDOFF
```

`/goal` condition 示例：

```text
Execute the dynamic workflow in .dynamic-workflow/runs/<run_id>/plan.yaml.
Follow .dynamic-workflow/runs/<run_id>/PROTOCOL.md.
Print DW_STEP_VERIFY and DW_STEP_DONE for each step.
Run final review before completion.
Done when DW_RUN_COMPLETE appears with no DW_RUN_HANDOFF.
```

## 8. Skill 里的 Prompt 模板

### Planner Prompt

```text
You are a workflow planner.
Generate a typed workflow plan.
Do not execute.
Only use registered step types.
Every loop must have max_rounds and stop_condition.
Every write-capable step must declare permission_profile.
Return YAML only.
```

### Reviewer Prompt

```text
You are an adversarial reviewer.
Read the provided artifacts only.
Do not edit files.
Find missed requirements, unsafe permissions, invalid assumptions, and incomplete validation.
Return structured JSON.
```

### Synthesizer Prompt

```text
Summarize workflow results for the user.
Do not expose internal prompts, secrets, local paths, or raw trace.
Mention completed steps, failed steps, and required user actions.
```

## 9. 最小可落地版本

第一版不要做 JS sandbox。先做 typed plan + scripts。

MVP：

```text
SKILL.md
commands/dw-plan.md
commands/dw-run.md
scripts/validate-plan.ts
scripts/run-workflow.ts
templates/typed-plan.yaml
templates/PROTOCOL.md
```

支持模式：

- fan-out and synthesize。
- adversarial verification。
- loop until done，最多 3 轮。

支持 backend：

- local mock backend。
- Codex CLI/backend。
- Claude CLI/backend。

后续再补：

- ACP adapter。
- JS sandbox。
- cached resume。
- UI status view。

## 9.1 Supergoal 给本方案的具体启发

可以直接借鉴：

- **payload 边界**：只把 `skills/dynamic-workflow/` 当安装 payload；repo 根目录的 README/tests/manifest 是发布和开发辅助。
- **artifact 目录**：运行产物写 `.dynamic-workflow/`，不要写回 skill payload。
- **skill directory 定位**：运行时先解析 `DW_SKILL_DIR`，所有 scripts/templates/references 都从这里读取。
- **templates 固化协议**：把执行 loop、failure recovery、final review 写成 `templates/PROTOCOL.md`，dispatch 时复制到 run 目录。
- **transcript markers**：用 `DW_*` 命名块，让 host evaluator 和用户都能判断进度。
- **one-paste handoff**：对需要长时间自主执行的 workflow，生成一条 `/goal`，用户粘贴一次后按磁盘 plan 执行。
- **确定性脚本**：plan validation、state comparison、trace summarization 都放 scripts，不靠 prompt 自觉。
- **版本化分发**：Claude plugin manifest 的 version 是 marketplace 刷新的关键；Codex 用户需要重新 copy。

## 10. 关键风险

- Skill 只写说明，不提供 deterministic scripts，agent 执行会漂移。
- Slash command 直接让 agent 自由发挥，没有 typed plan。
- generated JS 直接跑在 Node 全权限环境。
- reviewer 也有写权限。
- loop 没有预算。
- trace 不落盘，失败后无法恢复。
- backend 不支持权限约束但 runtime 假装支持。

## 11. 推荐落地顺序

1. 建 repo 骨架：`.claude-plugin/`、`skills/dynamic-workflow/`、README、CHANGELOG。
2. 写 `SKILL.md`，只描述入口、阶段、边界和目录定位。
3. 写 templates：`plan.yaml`、`STATE.md`、`PROTOCOL.md`。
4. 写 `validate-plan.ts`，先保证 typed plan 可校验。
5. 写 `/dw-plan` skill command，生成 plan 但不执行。
6. 写 mock `run-workflow.ts`，只创建 `.dynamic-workflow/runs/<run_id>`、写 trace，不调真实 agent。
7. 写 `/dw-run`，采用 one-paste `/goal` 或 current-agent inline 执行二选一。
8. 写 final review / summarize trace。
9. 接 Claude/Codex CLI backend。
10. 接 ACP backend。
11. 加 resume/cache。
12. 最后再考虑 JS sandbox。
