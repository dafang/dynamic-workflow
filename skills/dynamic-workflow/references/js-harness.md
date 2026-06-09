# JS Harness Bridge

The MVP bridge records constrained workflow SDK calls and compiles them to a typed plan. It does not execute generated JavaScript with unrestricted Node permissions.

Allowed SDK primitives:

- `agent`
- `command`
- `agent.review`
- `agent.synthesize`
- `agent.execute`
- `parallel`
- `pipeline`
- `loop`
- `judge`
- `StepHandle.output(selector)` inside declarative `context` objects
- `artifact.read`
- `artifact.write`
- `askUser`

Dataflow capture:

```js
const docs = command("collect_docs", {
  run: ["sed -n '1,120p' README.md"],
});

agent.review("review_docs", {
  prompt: "Review collected docs.",
  context: {
    docs: docs.output("$.verify.checks[*].stdout"),
  },
});
```

The harness captures this as typed IR with `depends_on: [collect_docs]` and `consumes: [{ from: "collect_docs", select: "$.verify.checks[*].stdout", as: "docs" }]`. Unsupported executable syntax such as `if`, `for`, `while`, `switch`, `try`, and `class` fails closed.

Denied capabilities:

- `fs`
- `child_process`
- `process.env`
- network or `fetch`
- dynamic `import`
- `require`
- `eval`
- `new Function`
- global object escape

Backend behavior remains fail-closed: omitted backend means `current`, and explicit external backends fail closed.
