import path from "node:path";

import { RunStore } from "../store.js";
import { parseRootFlag, type CommandContext } from "./common.js";

export async function statusCommand(args: string[], context: CommandContext): Promise<number> {
  const { rootDir, rest } = parseRootFlag(args);
  const [runId] = rest;
  if (!runId) {
    context.stderr.write("Usage: dw status <run-id> [--root <dir>]\n");
    return 2;
  }
  const store = new RunStore(rootDir);
  try {
    const record = await store.loadRun(runId);
    context.stdout.write(`run ${record.run_id} state=${record.state}\n`);
    for (const step of Object.values(record.steps)) {
      context.stdout.write(`step ${step.step_id} state=${step.state} attempts=${step.attempts}\n`);
    }
    context.stdout.write(`trace ${path.join(record.run_dir, "trace.jsonl")}\n`);
    return 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
