export const SUPPORTED_SCHEMA_VERSION = "dynamic_workflow/run/v1";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type WorkflowBackend = "current";

export type WorkflowKind =
  | "mixed"
  | "build_capabilities"
  | "review"
  | "research"
  | "implementation"
  | string;

export type PermissionProfileName =
  | "classifier"
  | "executor_writer"
  | "reviewer_readonly"
  | "synthesizer"
  | "research"
  | "command_verifier"
  | "human_approval";

export type StepType =
  | "agent.classify"
  | "agent.execute"
  | "agent.review"
  | "agent.synthesize"
  | "agent.generate"
  | "agent.filter"
  | "agent.judge_pair"
  | "workflow.include"
  | "workflow.loop"
  | "workflow.tournament"
  | "command.verify"
  | "human.approval";

export type ConditionOperator = "==" | "!=" | ">" | ">=" | "<" | "<=" | "exists" | "not_exists";

export interface RunCondition {
  step: string;
  output_path: string;
  op: ConditionOperator;
  value?: JsonValue;
}

export interface WorkflowBudget {
  max_steps?: number;
  max_subagents?: number;
  max_rounds?: number;
  max_minutes?: number;
}

export interface StepBudget {
  max_rounds?: number;
  max_minutes?: number;
  max_tokens?: number;
}

export interface VerificationSpec {
  commands?: string[];
  required_artifacts?: string[];
  output_schema?: JsonObject;
}

export interface ArtifactRef {
  from: string;
  select: string;
  required?: boolean;
  max_bytes?: number;
}

export interface StepConsume extends ArtifactRef {
  as: string;
}

export interface StepProduce {
  select: string;
  schema?: string;
}

export type StepProduces = Record<string, StepProduce>;

export interface WorkflowStep {
  step_id: string;
  type: StepType;
  title?: string;
  input?: JsonObject;
  depends_on: string[];
  consumes?: StepConsume[];
  produces?: StepProduces;
  permission_profile?: PermissionProfileName;
  backend?: WorkflowBackend;
  budget?: StepBudget;
  run_if?: RunCondition;
  strategy?: string;
  verify?: VerificationSpec;
}

export interface WorkflowPlan {
  schema_version: typeof SUPPORTED_SCHEMA_VERSION;
  workflow_id: string;
  kind: WorkflowKind;
  scope_id?: string;
  request?: string;
  backend?: WorkflowBackend;
  budget?: WorkflowBudget;
  steps: WorkflowStep[];
  metadata?: JsonObject;
}

export interface ValidationError {
  code: string;
  message: string;
  step_id?: string;
  path?: string;
}

export type ValidationResult =
  | { ok: true; plan: WorkflowPlan; errors: [] }
  | { ok: false; errors: ValidationError[] };

export type WorkflowState =
  | "draft"
  | "validated"
  | "running"
  | "completed"
  | "failed"
  | "waiting_user"
  | "cancelled"
  | "partial_succeeded";

export type StepState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "waiting_user";
