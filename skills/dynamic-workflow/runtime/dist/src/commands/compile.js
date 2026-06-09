import { compilePlan } from "../compiler.js";
import { readPlanFile, writeJson } from "./common.js";
export async function compileCommand(args, context) {
    const [planPath] = args;
    if (!planPath) {
        context.stderr.write("Usage: dw compile <plan>\n");
        return 2;
    }
    try {
        writeJson(context.stdout, compilePlan(await readPlanFile(planPath)));
        return 0;
    }
    catch (error) {
        context.stderr.write(`${error.message}\n`);
        return 1;
    }
}
//# sourceMappingURL=compile.js.map