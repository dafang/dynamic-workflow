import path from "node:path";

import { auditRun } from "../audit.js";
import { readJson } from "../artifacts.js";
import type { CompiledManifest } from "../compiler.js";
import { RunStore } from "../store.js";
import { parseRootFlag, writeJson, type CommandContext } from "./common.js";

export async function reviewCommand(args: string[], context: CommandContext): Promise<number> {
  const { rootDir, rest } = parseRootFlag(args);
  const [runId] = rest;
  if (!runId) {
    context.stderr.write("Usage: dw review <run-id> [--root <dir>]\n");
    return 2;
  }
  const store = new RunStore(rootDir);
  try {
    const record = await store.loadRun(runId);
    const manifest = await readJson<CompiledManifest>(path.join(record.run_dir, "compiled_manifest.json"));
    const audit = await auditRun({ runDir: record.run_dir, workflowState: record.state, manifest, steps: record.steps });
    writeJson(context.stdout, audit);
    return audit.ok ? 0 : 1;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
