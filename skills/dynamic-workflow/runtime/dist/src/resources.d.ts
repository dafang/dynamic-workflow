import type { WorkflowStep } from "./types.js";
export interface ResourceLock {
    step_id: string;
    scope: string;
    mode: "read" | "write";
}
export declare function computeResourceLocks(steps: WorkflowStep[], defaultScope?: string): ResourceLock[];
export declare function writerConflicts(locks: ResourceLock[], dependencies?: Record<string, string[]>): Record<string, string[]>;
//# sourceMappingURL=resources.d.ts.map