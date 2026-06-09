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

export function resolveBackendName(value: unknown): "current" {
  if (value === undefined || value === "current") return "current";
  throw unsupportedBackendError(String(value));
}

export function unsupportedBackendError(name: string): Error {
  const error = new Error(`Unsupported backend ${name}; dynamic-workflow MVP only executes backend current.`);
  error.name = "UnsupportedBackendError";
  return error;
}
