import { compilePlan } from "../compiler.js";
import { lintPlan } from "../lints.js";
import { assertValidPlan } from "../validation.js";
import { readPlanFile, writeJson, type CommandContext } from "./common.js";

export async function compileCommand(args: string[], context: CommandContext): Promise<number> {
  const [planPath] = args;
  if (!planPath) {
    context.stderr.write("Usage: dw compile <plan>\n");
    return 2;
  }
  try {
    const planInput = await readPlanFile(planPath);
    const plan = assertValidPlan(planInput);
    for (const warning of lintPlan(plan)) {
      context.stderr.write(`warning ${warning.code}${warning.step_id ? ` step=${warning.step_id}` : ""}: ${warning.message}\n`);
    }
    writeJson(context.stdout, compilePlan(plan));
    return 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
