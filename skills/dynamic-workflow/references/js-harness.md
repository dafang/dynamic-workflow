# JS Harness Bridge

The MVP bridge records constrained workflow SDK calls and compiles them to a typed plan. It does not execute generated JavaScript with unrestricted Node permissions.

Allowed SDK primitives:

- `agent`
- `parallel`
- `pipeline`
- `loop`
- `judge`
- `artifact.read`
- `artifact.write`
- `askUser`

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

Backend behavior is unchanged: omitted backend means `current`, and explicit external backends fail closed.
