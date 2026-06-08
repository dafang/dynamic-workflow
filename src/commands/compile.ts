import { compilePlan } from "../compiler.js";
import { readPlanFile, writeJson, type CommandContext } from "./common.js";

export async function compileCommand(args: string[], context: CommandContext): Promise<number> {
  const [planPath] = args;
  if (!planPath) {
    context.stderr.write("Usage: dw compile <plan>\n");
    return 2;
  }
  try {
    writeJson(context.stdout, compilePlan(await readPlanFile(planPath)));
    return 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
