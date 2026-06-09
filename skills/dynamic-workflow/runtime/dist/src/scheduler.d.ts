import type { CompiledManifest } from "./compiler.js";
import type { StepState } from "./types.js";
export interface StepRuntimeState {
    step_id: string;
    state: StepState;
    attempts: number;
    summary?: string;
    output_path?: string;
    failure?: string;
}
export declare function initialStepStates(manifest: CompiledManifest): Record<string, StepRuntimeState>;
export declare function getReadyStepIds(manifest: CompiledManifest, states: Record<string, StepRuntimeState>): string[];
export declare function blockDownstream(manifest: CompiledManifest, states: Record<string, StepRuntimeState>, failedStepId: string): void;
//# sourceMappingURL=scheduler.d.ts.map