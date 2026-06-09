import { type CompiledManifest } from "./compiler.js";
import type { WorkflowPlan } from "./types.js";
export declare const HARNESS_ALLOWED_PRIMITIVES: readonly ["agent", "command", "parallel", "pipeline", "loop", "judge", "artifact.read", "artifact.write", "askUser"];
export declare const HARNESS_DENIED_CAPABILITIES: readonly ["fs", "child_process", "process", "process.env", "fetch", "import", "import(", "require(", "eval(", "Function(", "new Function", "globalThis", "global", "window", "self", "constructor", "constructor.constructor", "computed_member_access"];
export interface HarnessCompileResult {
    plan: WorkflowPlan;
    manifest: CompiledManifest;
}
export declare function compileHarnessToPlan(source: string, workflowId?: string): HarnessCompileResult;
export declare function assertHarnessSourceAllowed(source: string): void;
//# sourceMappingURL=harness.d.ts.map