import type { WorkflowPlan } from "./types.js";
export interface PlanWarning {
    code: string;
    message: string;
    step_id?: string;
    path?: string;
}
export declare function lintPlan(plan: WorkflowPlan): PlanWarning[];
//# sourceMappingURL=lints.d.ts.map