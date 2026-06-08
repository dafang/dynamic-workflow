# Dynamic Workflow 模式

本文把常见 dynamic workflow 模式拆成三层：

```text
模式名
  -> 编排结构
  -> runtime 机制
```

## 1. Fan-out and Synthesize

### 适用

- 大规模代码审查。
- 多模块并行分析。
- Deep research。
- 子任务互相独立，但最终需要统一结论。

### 实现

```js
const results = await parallel([
  agent("分析 gateway 相关代码", { tools: ["read_only"] }),
  agent("分析 group app runtime", { tools: ["read_only"] }),
  agent("分析 UI entry update flow", { tools: ["read_only"] }),
])

const summary = await agent("汇总这些分析，去重并给出结论", {
  role: "synthesizer",
  input: results,
})
```

### 关键机制

- parallel 是 barrier，必须等所有分支完成。
- 每个 subagent 独立上下文。
- 输出结构化，便于合并。
- synthesizer 负责去重、冲突处理、结论排序。

## 2. Adversarial Verification

### 适用

- 代码生成后的审查。
- 安全/权限相关变更。
- 高风险发布。
- 需要避免“自己验自己”。

### 实现

```js
const draft = await agent("实现这个功能", {
  tools: ["filesystem", "terminal"],
})

const review = await agent("严格审查这个实现，找 bug、遗漏和风险", {
  role: "adversarial_reviewer",
  input: draft,
  tools: ["read_only"],
})

if (!review.ok) {
  await agent("根据 review 意见修复", {
    input: { draft, review },
    tools: ["filesystem", "terminal"],
  })
}
```

### 关键机制

- executor 和 reviewer 上下文隔离。
- reviewer 最好只读。
- review criteria 预先写清楚。
- reviewer 输出结构化：`ok`、`findings`、`blocking`、`confidence`。

## 3. Classify and Act

### 适用

- 工单分拣。
- 用户意图路由。
- 混合输入队列。
- 多类任务有不同处理路径。

### 实现

```js
const cls = await agent("判断这个请求类型", {
  outputSchema: {
    kind: ["bug", "feature", "research", "deploy"],
    confidence: "number",
    reason: "string"
  }
})

switch (cls.kind) {
  case "bug":
    return pipeline([analyzeBug, fixBug, verifyFix])
  case "feature":
    return pipeline([designFeature, implementFeature, acceptFeature])
  case "research":
    return fanOutResearch()
}
```

### 关键机制

- 分类标签有限且稳定。
- 每类标签有明确后续动作。
- 低置信度时问人，不强行路由。
- 分类结果本身要记录到 trace。

## 4. Generate and Filter

### 适用

- 方案探索。
- 命名/产品想法。
- 架构候选。
- 搜索空间大，需要先发散再收敛。

### 实现

```js
const candidates = await parallel([
  agent("给出保守方案"),
  agent("给出激进方案"),
  agent("给出低成本方案"),
])

const ranked = await agent("按正确性、成本、可维护性筛选这些方案", {
  role: "filter",
  input: candidates,
  outputSchema: "ranking",
})
```

### 关键机制

- 生成阶段鼓励多样性。
- filter 阶段使用固定 criteria。
- 输出包含排序、理由、淘汰原因。
- 适合 design 前发散。

## 5. Tournament

### 适用

- 多个架构方案比较。
- 多个实现策略取舍。
- 需要相对排序，而不是绝对打分。

### 实现

```js
let candidates = await parallel([
  agent("用方案 A 解决"),
  agent("用方案 B 解决"),
  agent("用方案 C 解决"),
  agent("用方案 D 解决"),
])

while (candidates.length > 1) {
  const pairs = pairUp(candidates)
  candidates = await parallel(pairs.map(([a, b]) =>
    agent("比较两个方案，选一个胜者", {
      role: "judge",
      input: { a, b, criteria },
    })
  ))
}
```

### 关键机制

- 两两比较通常比一次性绝对打分稳定。
- judge 标准必须提前固定。
- 每轮保留胜者和淘汰理由。
- 适合复杂方案评估，不适合简单任务。

## 6. Loop Until Done

### 适用

- 调试。
- 批量清理。
- 构建失败后修复。
- 不知道需要几轮才能完成的任务。

### 实现

```js
let state = initialState

for (let round = 0; round < maxRounds; round++) {
  const result = await agent("继续排查并修复当前问题", {
    input: state,
    tools: ["filesystem", "terminal"],
  })

  const check = await agent("判断是否完成", {
    role: "verifier",
    input: result,
    outputSchema: { done: "boolean", reason: "string" },
  })

  if (check.done) break
  state = { ...state, lastResult: result, review: check }
}
```

### 关键机制

- 必须有 `maxRounds`、token、time budget。
- 必须有明确 stop condition。
- 每轮状态要持久化。
- verifier 不应和 executor 是同一个上下文。

## 7. 组合模式

真实 workflow 常常是组合：

```text
Classify and Act
  -> Fan-out builders
  -> Adversarial Verification
  -> Loop Until Done on failed checks
  -> Synthesize summary
```

组合时要注意：

- 每层都需要预算。
- 每层都要有结构化输出。
- 失败语义不能只靠自然语言描述。
- 需要明确哪些结果进入下一阶段，哪些只作为日志。
