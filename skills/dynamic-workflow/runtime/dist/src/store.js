import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJson } from "./artifacts.js";
export class RunStore {
    rootDir;
    constructor(rootDir = ".dynamic-workflow") {
        this.rootDir = rootDir;
    }
    runDir(runId) {
        return path.join(this.rootDir, "runs", runId);
    }
    async createRun(runId, plan, manifest, steps) {
        const runDir = this.runDir(runId);
        await mkdir(path.join(runDir, "artifacts"), { recursive: true });
        await mkdir(path.join(runDir, "steps"), { recursive: true });
        await writeFile(path.join(runDir, "plan.yaml"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        await writeJson(path.join(runDir, "compiled_manifest.json"), manifest);
        const now = new Date().toISOString();
        const record = {
            run_id: runId,
            workflow_id: plan.workflow_id,
            state: "validated",
            created_at: now,
            updated_at: now,
            run_dir: runDir,
            steps
        };
        await this.saveRun(record);
        return record;
    }
    async saveRun(record) {
        record.updated_at = new Date().toISOString();
        await writeJson(path.join(record.run_dir, "run.json"), record);
    }
    async loadRun(runId) {
        const runDir = this.runDir(runId);
        return JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    }
}
//# sourceMappingURL=store.js.map