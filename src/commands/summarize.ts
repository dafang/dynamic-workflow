import { sanitizeForUser } from "../artifacts.js";
import { RunStore } from "../store.js";
import { parseRootFlag, writeJson, type CommandContext } from "./common.js";

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
    writeJson(context.stdout, sanitizeForUser({
      run_id: record.run_id,
      workflow_id: record.workflow_id,
      state: record.state,
      steps: Object.values(record.steps).map((step) => ({
        step_id: step.step_id,
        state: step.state,
        summary: step.summary
      }))
    }));
    return 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
