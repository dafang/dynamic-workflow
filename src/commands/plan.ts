import { lintPlan } from "../lints.js";
import { validatePlan } from "../validation.js";
import { readPlanFile, type CommandContext } from "./common.js";

export async function validateCommand(args: string[], context: CommandContext): Promise<number> {
  const [planPath] = args;
  if (!planPath) {
    context.stderr.write("Usage: dw validate <plan>\n");
    return 2;
  }
  const result = validatePlan(await readPlanFile(planPath));
  if (!result.ok) {
    context.stderr.write(`${JSON.stringify({ ok: false, errors: result.errors }, null, 2)}\n`);
    return 1;
  }
  context.stdout.write(`valid ${result.plan.workflow_id} steps=${result.plan.steps.length}\n`);
  for (const warning of lintPlan(result.plan)) {
    context.stdout.write(`warning ${warning.code}${warning.step_id ? ` step=${warning.step_id}` : ""}: ${warning.message}\n`);
  }
  return 0;
}
