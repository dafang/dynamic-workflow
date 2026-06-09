import type { Backend, BackendStepResult, StepContext } from "../backend.js";
import type { CompiledNode } from "../compiler.js";
export declare class CurrentBackend implements Backend {
    readonly name: "current";
    executeStep(node: CompiledNode, context: StepContext): Promise<BackendStepResult>;
}
//# sourceMappingURL=current.d.ts.map