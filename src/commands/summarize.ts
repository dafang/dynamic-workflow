import { readJson, sanitizeForUser } from "../artifacts.js";
import { RunStore } from "../store.js";
import { parseRootFlag, writeJson, type CommandContext } from "./common.js";
import type { JsonObject } from "../types.js";

export async function summarizeCommand(args: string[], context: CommandContext): Promise<number> {
  const { rootDir, rest } = parseRootFlag(args);
  const [runId] = rest;
  if (!runId) {
    context.stderr.write("Usage: dw summarize <run-id> [--root <dir>]\n");
    return 2;
  }
  const store = new RunStore(rootDir);
  try {
    const record = await store.loadRun(runId);
    const steps = await Promise.all(
      Object.values(record.steps).map(async (step) => {
        const artifact = step.output_path ? await readJson<JsonObject>(step.output_path).catch(() => undefined) : undefined;
        return {
          step_id: step.step_id,
          state: step.state,
          summary: step.summary,
          context_sources: readContextSourceSummary(artifact)
        };
      })
    );
    writeJson(context.stdout, sanitizeForUser({
      run_id: record.run_id,
      workflow_id: record.workflow_id,
      state: record.state,
      steps
    }));
    return 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

function readContextSourceSummary(artifact: JsonObject | undefined): JsonObject[] {
  const sources = artifact?.output;
  if (typeof sources !== "object" || sources === null || Array.isArray(sources)) return [];
  const contextSources = sources.context_sources;
  if (!Array.isArray(contextSources)) return [];
  return contextSources.flatMap((source) => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) return [];
    return [{
      alias: source.alias,
      from_step: source.from_step,
      selected_path: source.selected_path,
      clipped: source.clipped,
      original_bytes: source.original_bytes,
      selected_bytes: source.selected_bytes
    } as JsonObject];
  });
}
