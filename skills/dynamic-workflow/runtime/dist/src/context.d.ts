import type { CompiledNode } from "./compiler.js";
import type { StepRuntimeState } from "./scheduler.js";
import type { StepContext } from "./backend.js";
import type { JsonValue } from "./types.js";
interface BuildContextParams {
    runId: string;
    node: CompiledNode;
    steps: Record<string, StepRuntimeState>;
    trace?: StepContext["trace"];
}
export declare function buildStepContext(params: BuildContextParams): Promise<StepContext>;
export declare function selectArtifactValue(value: JsonValue, selector: string): JsonValue | undefined;
export {};
//# sourceMappingURL=context.d.ts.map