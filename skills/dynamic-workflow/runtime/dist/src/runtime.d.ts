import { type AuditResult } from "./audit.js";
import type { Backend } from "./backend.js";
import { type CompiledManifest } from "./compiler.js";
import { type RunRecord } from "./store.js";
import type { WorkflowPlan } from "./types.js";
export interface RunWorkflowOptions {
    rootDir?: string;
    runId?: string;
    backend?: Backend;
    stopAfterStepId?: string;
}
export interface RunWorkflowResult {
    record: RunRecord;
    manifest: CompiledManifest;
    audit: AuditResult;
    markers: string[];
}
export declare function runWorkflow(planInput: unknown, options?: RunWorkflowOptions): Promise<RunWorkflowResult>;
export declare function createRunId(plan: WorkflowPlan): string;
//# sourceMappingURL=runtime.d.ts.map