import type { CompiledManifest } from "./compiler.js";
import type { StepRuntimeState } from "./scheduler.js";
import type { JsonObject, WorkflowState } from "./types.js";
export interface AuditResult {
    ok: boolean;
    findings: JsonObject[];
}
export declare function auditRun(params: {
    runDir: string;
    workflowState: WorkflowState;
    manifest: CompiledManifest;
    steps: Record<string, StepRuntimeState>;
}): Promise<AuditResult>;
//# sourceMappingURL=audit.d.ts.map