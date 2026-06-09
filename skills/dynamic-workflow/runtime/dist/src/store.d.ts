import type { CompiledManifest } from "./compiler.js";
import type { StepRuntimeState } from "./scheduler.js";
import type { WorkflowPlan, WorkflowState } from "./types.js";
export interface RunRecord {
    run_id: string;
    workflow_id: string;
    state: WorkflowState;
    created_at: string;
    updated_at: string;
    run_dir: string;
    steps: Record<string, StepRuntimeState>;
}
export declare class RunStore {
    readonly rootDir: string;
    constructor(rootDir?: string);
    runDir(runId: string): string;
    createRun(runId: string, plan: WorkflowPlan, manifest: CompiledManifest, steps: Record<string, StepRuntimeState>): Promise<RunRecord>;
    saveRun(record: RunRecord): Promise<void>;
    loadRun(runId: string): Promise<RunRecord>;
}
//# sourceMappingURL=store.d.ts.map