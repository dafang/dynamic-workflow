import type { CompiledNode } from "./compiler.js";
import type { JsonObject } from "./types.js";
export interface StepContextSource {
    [key: string]: string | number | boolean;
    alias: string;
    from_step: string;
    output_path: string;
    selected_path: string;
    required: boolean;
    clipped: boolean;
    original_bytes: number;
    selected_bytes: number;
}
export interface StepContext {
    run_id: string;
    step_id: string;
    inputs: JsonObject;
    sources: StepContextSource[];
}
export interface BackendStepResult {
    status: "succeeded" | "failed" | "waiting_user";
    output: JsonObject;
    summary: string;
    verify?: {
        ok: boolean;
        checks: JsonObject[];
    };
}
export interface Backend {
    name: "current";
    executeStep(node: CompiledNode, context: StepContext): Promise<BackendStepResult>;
}
export declare function resolveBackendName(value: unknown): "current";
export declare function unsupportedBackendError(name: string): Error;
//# sourceMappingURL=backend.d.ts.map