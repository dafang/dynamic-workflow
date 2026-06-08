import path from "node:path";

import { readJson } from "../artifacts.js";
import type { CompiledManifest } from "../compiler.js";
import { RunStore } from "../store.js";
import { parseRootFlag, type CommandContext } from "./common.js";

export async function resumeCommand(args: string[], context: CommandContext): Promise<number> {
  const { rootDir, rest } = parseRootFlag(args);
  const [runId] = rest;
  if (!runId) {
    context.stderr.write("Usage: dw resume <run-id> [--root <dir>]\n");
    return 2;
  }
  const store = new RunStore(rootDir);
  try {
    const record = await store.loadRun(runId);
    await readJson<CompiledManifest>(path.join(record.run_dir, "compiled_manifest.json"));
    const succeeded = Object.values(record.steps).filter((step) => step.state === "succeeded").length;
    const pending = Object.values(record.steps).filter((step) => ["queued", "running"].includes(step.state)).length;
    context.stdout.write(`resume ${record.run_id} reused_succeeded=${succeeded} pending=${pending} state=${record.state}\n`);
    return record.state === "failed" ? 1 : 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
