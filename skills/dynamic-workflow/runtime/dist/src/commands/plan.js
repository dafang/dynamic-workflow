import { validatePlan } from "../validation.js";
import { readPlanFile } from "./common.js";
export async function validateCommand(args, context) {
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
    return 0;
}
//# sourceMappingURL=plan.js.map