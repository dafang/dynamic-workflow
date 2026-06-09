export const DYNAMIC_WORKFLOW_VERSION = "0.1.0";

export function getRuntimeBanner(): string {
  return `dynamic-workflow ${DYNAMIC_WORKFLOW_VERSION}`;
}

export type {
  ArtifactRef,
  CommandCollectionSpec,
  CommandDeclaration,
  CommandSpec,
  JsonObject,
  JsonValue,
  RunCondition,
  StepConsume,
  StepProduce,
  StepProduces,
  StepState,
  StepType,
  ValidationError,
  ValidationResult,
  WorkflowPlan,
  WorkflowState,
  WorkflowStep
} from "./types.js";
export { SUPPORTED_SCHEMA_VERSION } from "./types.js";
export { listPermissionProfiles, PERMISSION_PROFILES } from "./permissions.js";
export { listStepTypes, STEP_REGISTRY } from "./registry.js";
export { HOST_LIMITS } from "./schema.js";
export { assertValidPlan, validatePlan } from "./validation.js";
export { lintPlan } from "./lints.js";
export type { PlanWarning } from "./lints.js";
export { compilePlan } from "./compiler.js";
export type { BudgetSummary, CompiledManifest, CompiledNode } from "./compiler.js";
export { auditRun } from "./audit.js";
export { CurrentBackend } from "./backends/current.js";
export { runWorkflow } from "./runtime.js";
export type { RunWorkflowOptions, RunWorkflowResult } from "./runtime.js";
export { RunStore } from "./store.js";
export type { RunRecord } from "./store.js";
export { runCli } from "./cli.js";
export { compileHarnessToPlan, HARNESS_ALLOWED_PRIMITIVES, HARNESS_DENIED_CAPABILITIES } from "./harness.js";
export type { HarnessCompileResult } from "./harness.js";
