import { isPermissionProfileName } from "./permissions.js";
import { getStepDefinition, isStepType } from "./registry.js";
import { HOST_LIMITS, SUPPORTED_BACKEND, SUPPORTED_SCHEMA_VERSION } from "./schema.js";
import type {
  JsonObject,
  JsonValue,
  StepBudget,
  RunCondition,
  VerificationSpec,
  ValidationError,
  ValidationResult,
  WorkflowBudget,
  WorkflowPlan,
  WorkflowStep
} from "./types.js";

const CONDITION_OPS = new Set(["==", "!=", ">", ">=", "<", "<=", "exists", "not_exists"]);

export function validatePlan(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ code: "invalid_plan", message: "Plan must be an object.", path: "$" }] };
  }

  if (input.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    errors.push({
      code: "unsupported_schema_version",
      message: `Unsupported schema_version ${String(input.schema_version)}.`,
      path: "schema_version"
    });
  }

  const workflowId = readString(input, "workflow_id", errors);
  const kind = readOptionalString(input, "kind") ?? "mixed";
  const backend = readOptionalString(input, "backend");
  if (backend !== undefined && backend !== SUPPORTED_BACKEND) {
    errors.push({
      code: "unsupported_backend",
      message: `Backend ${backend} is not executable in the MVP; use current or omit backend.`,
      path: "backend"
    });
  }

  const budget = readBudget(input.budget, "budget", errors, false);
  const rawSteps = readStepsArray(input, errors);
  const normalizedSteps: WorkflowStep[] = [];
  const seen = new Set<string>();

  for (const [index, rawStep] of rawSteps.entries()) {
    const path = `steps[${index}]`;
    if (!isRecord(rawStep)) {
      errors.push({ code: "invalid_step", message: "Step must be an object.", path });
      continue;
    }
    const stepId = readString(rawStep, "step_id", errors, path);
    if (stepId.length > 0) {
      if (seen.has(stepId)) {
        errors.push({ code: "duplicate_step_id", message: `Duplicate step_id ${stepId}.`, step_id: stepId, path });
      }
      seen.add(stepId);
    }

    const rawType = readString(rawStep, "type", errors, path);
    if (!isStepType(rawType)) {
      errors.push(withStepId({
        code: "unsupported_step_type",
        message: `Unsupported step type ${rawType}.`,
        path: `${path}.type`
      }, stepId));
      continue;
    }

    const definition = getStepDefinition(rawType);
    const profile = readOptionalString(rawStep, "permission_profile") ?? definition.defaultPermissionProfile;
    if (!isPermissionProfileName(profile)) {
      errors.push(withStepId({
        code: "unsupported_permission_profile",
        message: `Unsupported permission profile ${profile}.`,
        path: `${path}.permission_profile`
      }, stepId));
    } else if (!definition.allowedPermissionProfiles.includes(profile)) {
      errors.push(withStepId({
        code: "permission_profile_not_allowed",
        message: `Permission profile ${profile} is not allowed for ${rawType}.`,
        path: `${path}.permission_profile`
      }, stepId));
    }

    const stepBackend = readOptionalString(rawStep, "backend");
    if (stepBackend !== undefined && stepBackend !== SUPPORTED_BACKEND) {
      errors.push(withStepId({
        code: "unsupported_backend",
        message: `Step backend ${stepBackend} is not executable in the MVP; use current or omit backend.`,
        path: `${path}.backend`
      }, stepId));
    }

    const dependsOn = readStringArray(rawStep.depends_on ?? [], `${path}.depends_on`, errors);
    const runIf = readRunCondition(rawStep.run_if, `${path}.run_if`, stepId, errors);
    const stepBudget = readBudget(rawStep.budget, `${path}.budget`, errors, true);
    const inputObject = isRecord(rawStep.input) ? (rawStep.input as JsonObject) : undefined;

    if (rawType === "workflow.loop") {
      const loopInput = inputObject ?? {};
      if (!Number.isInteger(loopInput.max_rounds) || !("stop_condition" in loopInput)) {
        errors.push(withStepId({
          code: "invalid_loop",
          message: "workflow.loop requires input.max_rounds and input.stop_condition.",
          path: `${path}.input`
        }, stepId));
      }
    }

    if (rawType === "command.verify") {
      validateCommandVerifyCommands(rawStep, path, stepId, errors);
    }

    const normalizedStep: WorkflowStep = {
      step_id: stepId,
      type: rawType,
      depends_on: dependsOn,
      permission_profile: isPermissionProfileName(profile) ? profile : definition.defaultPermissionProfile,
    };
    assignOptional(normalizedStep, "title", readOptionalString(rawStep, "title"));
    assignOptional(normalizedStep, "input", inputObject);
    assignOptional(normalizedStep, "backend", stepBackend === SUPPORTED_BACKEND ? stepBackend : undefined);
    assignOptional(normalizedStep, "budget", stepBudget);
    assignOptional(normalizedStep, "run_if", runIf);
    assignOptional(normalizedStep, "strategy", readOptionalString(rawStep, "strategy"));
    assignOptional(normalizedStep, "verify", readVerificationSpec(rawStep.verify));
    normalizedSteps.push(normalizedStep);
  }

  validateReferences(normalizedSteps, errors);
  validateCycles(normalizedSteps, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const plan: WorkflowPlan = {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    workflow_id: workflowId,
    kind,
    steps: normalizedSteps
  };
  assignOptional(plan, "scope_id", readOptionalString(input, "scope_id"));
  assignOptional(plan, "request", readOptionalString(input, "request"));
  assignOptional(plan, "backend", backend === SUPPORTED_BACKEND ? backend : undefined);
  assignOptional(plan, "budget", budget);
  assignOptional(plan, "metadata", isRecord(input.metadata) ? (input.metadata as JsonObject) : undefined);

  return {
    ok: true,
    plan,
    errors: []
  };
}

export function assertValidPlan(input: unknown): WorkflowPlan {
  const result = validatePlan(input);
  if (!result.ok) {
    const detail = result.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new Error(`Invalid dynamic workflow plan: ${detail}`);
  }
  return result.plan;
}

function readStepsArray(input: Record<string, unknown>, errors: ValidationError[]): unknown[] {
  const direct = input.steps;
  const nestedPlan = input.plan;
  const nested = isRecord(nestedPlan) ? nestedPlan.steps : undefined;
  const candidate = direct ?? nested;
  if (!Array.isArray(candidate)) {
    errors.push({ code: "missing_steps", message: "Plan must define steps or plan.steps.", path: "steps" });
    return [];
  }
  if (candidate.length === 0) {
    errors.push({ code: "empty_plan", message: "Plan must contain at least one step.", path: "steps" });
  }
  return candidate;
}

function readString(
  object: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
  basePath = ""
): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({
      code: "invalid_string",
      message: `${key} must be a non-empty string.`,
      path: basePath ? `${basePath}.${key}` : key
    });
    return "";
  }
  return value;
}

function readOptionalString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readStringArray(value: unknown, path: string, errors: ValidationError[]): string[] {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_string_array", message: `${path} must be an array of strings.`, path });
    return [];
  }
  const strings: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push({
        code: "invalid_string_array",
        message: `${path}[${index}] must be a non-empty string.`,
        path: `${path}[${index}]`
      });
      continue;
    }
    strings.push(item);
  }
  return strings;
}

function readRunCondition(
  value: unknown,
  path: string,
  stepId: string,
  errors: ValidationError[]
): RunCondition | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(withStepId({ code: "invalid_run_if", message: "run_if must be an object.", path }, stepId));
    return undefined;
  }
  const step = readString(value, "step", errors, path);
  const outputPath = readString(value, "output_path", errors, path);
  const op = readString(value, "op", errors, path);
  if (!CONDITION_OPS.has(op)) {
    errors.push(withStepId({ code: "invalid_condition_op", message: `Unsupported run_if op ${op}.`, path }, stepId));
  }
  const condition: RunCondition = {
    step,
    output_path: outputPath,
    op: CONDITION_OPS.has(op) ? (op as RunCondition["op"]) : "=="
  };
  assignOptional(condition, "value", isJsonValue(value.value) ? value.value : undefined);
  return condition;
}

function readBudget(
  value: unknown,
  path: string,
  errors: ValidationError[],
  stepBudget: boolean
): (WorkflowBudget & StepBudget) | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ code: "invalid_budget", message: `${path} must be an object.`, path });
    return undefined;
  }
  const budget: WorkflowBudget & StepBudget = {};
  const limits = {
    max_steps: HOST_LIMITS.max_steps,
    max_subagents: HOST_LIMITS.max_subagents,
    max_rounds: stepBudget ? HOST_LIMITS.step_max_rounds : HOST_LIMITS.max_rounds,
    max_minutes: stepBudget ? HOST_LIMITS.step_max_minutes : HOST_LIMITS.max_minutes,
    max_tokens: HOST_LIMITS.step_max_tokens
  } as const;
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const max = limits[key];
    const current = value[key];
    if (current === undefined) continue;
    if (typeof current !== "number" || !Number.isInteger(current) || current <= 0) {
      errors.push({ code: "invalid_budget", message: `${path}.${key} must be a positive integer.`, path: `${path}.${key}` });
      continue;
    }
    if (current > max) {
      errors.push({
        code: "budget_exceeds_host_limit",
        message: `${path}.${key}=${current} exceeds host maximum ${max}.`,
        path: `${path}.${key}`
      });
      continue;
    }
    assignOptional(budget, key, current);
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function validateCommandVerifyCommands(
  rawStep: Record<string, unknown>,
  path: string,
  stepId: string,
  errors: ValidationError[]
): void {
  const inputCommands = isRecord(rawStep.input) ? rawStep.input.commands : undefined;
  const verifyCommands = isRecord(rawStep.verify) ? rawStep.verify.commands : undefined;
  const commands = verifyCommands ?? inputCommands;
  if (!Array.isArray(commands) || commands.length === 0) {
    errors.push(withStepId({
      code: "missing_verify_commands",
      message: "command.verify requires non-empty verify.commands or input.commands.",
      path: `${path}.verify.commands`
    }, stepId));
    return;
  }
  for (const [index, command] of commands.entries()) {
    if (typeof command !== "string" || command.trim() === "") {
      errors.push(withStepId({
        code: "invalid_verify_command",
        message: `command.verify command ${index} must be a non-empty string.`,
        path: `${path}.verify.commands[${index}]`
      }, stepId));
    }
  }
}

function readVerificationSpec(value: unknown): VerificationSpec | undefined {
  if (!isRecord(value)) return undefined;
  const spec: VerificationSpec = {};
  if (Array.isArray(value.commands) && value.commands.every((command) => typeof command === "string")) {
    spec.commands = value.commands;
  }
  if (Array.isArray(value.required_artifacts) && value.required_artifacts.every((artifact) => typeof artifact === "string")) {
    spec.required_artifacts = value.required_artifacts;
  }
  if (isRecord(value.output_schema)) {
    spec.output_schema = value.output_schema as JsonObject;
  }
  return Object.keys(spec).length > 0 ? spec : undefined;
}

function validateReferences(steps: WorkflowStep[], errors: ValidationError[]): void {
  const ids = new Set(steps.map((step) => step.step_id));
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!ids.has(dependency)) {
        errors.push({
          code: "unknown_dependency",
          message: `Step ${step.step_id} depends on missing step ${dependency}.`,
          step_id: step.step_id,
          path: `${step.step_id}.depends_on`
        });
      }
    }
    if (step.run_if && !ids.has(step.run_if.step)) {
      errors.push({
        code: "unknown_run_if_step",
        message: `Step ${step.step_id} run_if references missing step ${step.run_if.step}.`,
        step_id: step.step_id,
        path: `${step.step_id}.run_if.step`
      });
    }
  }
}

function validateCycles(steps: WorkflowStep[], errors: ValidationError[]): void {
  const byId = new Map(steps.map((step) => [step.step_id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(stepId: string, path: string[]): void {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      errors.push({
        code: "dependency_cycle",
        message: `Dependency cycle detected: ${[...path, stepId].join(" -> ")}.`,
        step_id: stepId
      });
      return;
    }
    const step = byId.get(stepId);
    if (!step) return;
    visiting.add(stepId);
    for (const dependency of step.depends_on) {
      visit(dependency, [...path, stepId]);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  }

  for (const step of steps) {
    visit(step.step_id, []);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withStepId(error: Omit<ValidationError, "step_id">, stepId: string): ValidationError {
  return stepId ? { ...error, step_id: stepId } : error;
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}
