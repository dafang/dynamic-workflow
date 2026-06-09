import { runWorkflow } from "../runtime.js";
import { readPlanFile, parseRootFlag } from "./common.js";
export async function runCommand(args, context) {
    const { rootDir, rest } = parseRootFlag(args);
    const [planPath] = rest;
    if (!planPath) {
        context.stderr.write("Usage: dw run <plan> [--root <dir>]\n");
        return 2;
    }
    try {
        const options = rootDir === undefined ? {} : { rootDir };
        const result = await runWorkflow(await readPlanFile(planPath), options);
        context.stdout.write(`DW_RUN_START ${result.record.run_id}\n`);
        for (const marker of result.markers) {
            context.stdout.write(`${marker}\n`);
        }
        context.stdout.write(`run_dir ${result.record.run_dir}\n`);
        return result.audit.ok ? 0 : 1;
    }
    catch (error) {
        context.stderr.write(`${error.message}\n`);
        return 1;
    }
}
//# sourceMappingURL=run.js.map