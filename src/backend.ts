import type { CompiledNode } from "./compiler.js";
import type { JsonObject } from "./types.js";

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
  executeStep(node: CompiledNode): Promise<BackendStepResult>;
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
