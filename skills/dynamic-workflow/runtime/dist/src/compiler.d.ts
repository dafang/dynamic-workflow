import { type ResourceLock } from "./resources.js";
import type { JsonObject, RunCondition, StepConsume, StepProduces, StepType, VerificationSpec, WorkflowPlan, WorkflowStep } from "./types.js";
export interface CompiledNode {
    step_id: string;
    type: StepType;
    title?: string;
    input: JsonObject;
    depends_on: string[];
    reverse_dependencies: string[];
    consumes?: StepConsume[];
    produces?: StepProduces;
    permission_profile: string;
    backend: "current";
    run_if?: RunCondition;
    verify?: VerificationSpec;
    resource_locks: ResourceLock[];
    control_origin?: string;
}
export interface BudgetSummary {
    max_steps?: number;
    max_subagents?: number;
    max_rounds?: number;
    max_minutes?: number;
    declared_steps: number;
    executable_nodes: number;
}
export interface CompiledManifest {
    manifest_version: "dynamic_workflow/compiled/v2";
    workflow_id: string;
    nodes: CompiledNode[];
    dependencies: Record<string, string[]>;
    reverse_dependencies: Record<string, string[]>;
    ready_queue: string[];
    resource_locks: ResourceLock[];
    writer_conflicts: Record<string, string[]>;
    budget_summary: BudgetSummary;
    original_plan: WorkflowPlan;
}
export interface CompileOptions {
    includeLibrary?: Record<string, WorkflowStep[]>;
}
export declare function compilePlan(input: unknown, options?: CompileOptions): CompiledManifest;
//# sourceMappingURL=compiler.d.ts.map