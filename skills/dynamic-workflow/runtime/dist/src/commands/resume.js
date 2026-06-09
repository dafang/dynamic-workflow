import path from "node:path";
import { readJson } from "../artifacts.js";
import { RunStore } from "../store.js";
import { parseRootFlag } from "./common.js";
export async function resumeCommand(args, context) {
    const { rootDir, rest } = parseRootFlag(args);
    const [runId] = rest;
    if (!runId) {
        context.stderr.write("Usage: dw resume <run-id> [--root <dir>]\n");
        return 2;
    }
    const store = new RunStore(rootDir);
    try {
        const record = await store.loadRun(runId);
        await readJson(path.join(record.run_dir, "compiled_manifest.json"));
        const succeeded = Object.values(record.steps).filter((step) => step.state === "succeeded").length;
        const pending = Object.values(record.steps).filter((step) => ["queued", "running"].includes(step.state)).length;
        context.stdout.write(`resume ${record.run_id} reused_succeeded=${succeeded} pending=${pending} state=${record.state}\n`);
        return record.state === "failed" ? 1 : 0;
    }
    catch (error) {
        context.stderr.write(`${error.message}\n`);
        return 1;
    }
}
//# sourceMappingURL=resume.js.map