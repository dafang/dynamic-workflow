import { validateOutputPath } from "./conditions.js";
import { computeResourceLocks, writerConflicts, type ResourceLock } from "./resources.js";
import { assertValidPlan } from "./validation.js";
import type {
  JsonObject,
  RunCondition,
  StepType,
  VerificationSpec,
  WorkflowBudget,
  WorkflowPlan,
  WorkflowStep
} from "./types.js";

export interface CompiledNode {
  step_id: string;
  type: StepType;
  title?: string;
  input: JsonObject;
  depends_on: string[];
  reverse_dependencies: string[];
  permission_profile: string;
  backend: "current";
  run_if?: RunCondition;
  verify?: VerificationSpec;
  resource_locks: ResourceLock[];
  control_origin?: string;
}

export interface BudgetSummary {
  max_steps?: number;
  max_subagents?: number;
  max_rounds?: number;
  max_minutes?: number;
  declared_steps: number;
  executable_nodes: number;
}

export interface CompiledManifest {
  manifest_version: "dynamic_workflow/compiled/v1";
  workflow_id: string;
  nodes: CompiledNode[];
  dependencies: Record<string, string[]>;
  reverse_dependencies: Record<string, string[]>;
  ready_queue: string[];
  resource_locks: ResourceLock[];
  writer_conflicts: Record<string, string[]>;
  budget_summary: BudgetSummary;
  original_plan: WorkflowPlan;
}

export interface CompileOptions {
  includeLibrary?: Record<string, WorkflowStep[]>;
}

const DEFAULT_INCLUDE_LIBRARY: Record<string, WorkflowStep[]> = {
  "builtin.feature": [
    {
      step_id: "implement",
      type: "agent.execute",
      permission_profile: "executor_writer",
      input: { prompt: "Implement the classified feature request." },
      depends_on: []
    },
    {
      step_id: "review",
      type: "agent.review",
      permission_profile: "reviewer_readonly",
      input: { prompt: "Review the implementation for correctness and test coverage." },
      depends_on: ["implement"]
    }
  ],
  "builtin.bugfix": [
    {
      step_id: "diagnose",
      type: "agent.review",
      permission_profile: "reviewer_readonly",
      input: { prompt: "Diagnose the reported failure." },
      depends_on: []
    },
    {
      step_id: "fix",
      type: "agent.execute",
      permission_profile: "executor_writer",
      input: { prompt: "Apply a focused bug fix." },
      depends_on: ["diagnose"]
    }
  ]
};

export function compilePlan(input: unknown, options: CompileOptions = {}): CompiledManifest {
  const originalPlan = assertValidPlan(input);
  const includeLibrary = options.includeLibrary ?? DEFAULT_INCLUDE_LIBRARY;
  const expandedSteps = expandControlSteps(originalPlan.steps, includeLibrary);
  validateCompiledConditions(expandedSteps);

  const dependencies = Object.fromEntries(expandedSteps.map((step) => [step.step_id, [...step.depends_on].sort()]));
  const reverseDependencies = buildReverseDependencies(expandedSteps);
  const allLocks = computeResourceLocks(expandedSteps);
  const locksByStep = new Map<string, ResourceLock[]>();
  for (const lock of allLocks) {
    locksByStep.set(lock.step_id, [...(locksByStep.get(lock.step_id) ?? []), lock]);
  }

  const nodes = expandedSteps.map((step): CompiledNode => {
    const node: CompiledNode = {
      step_id: step.step_id,
      type: step.type,
      input: step.input ?? {},
      depends_on: dependencies[step.step_id] ?? [],
      reverse_dependencies: reverseDependencies[step.step_id] ?? [],
      permission_profile: step.permission_profile ?? "executor_writer",
      backend: "current",
      resource_locks: locksByStep.get(step.step_id) ?? []
    };
    assignOptional(node, "title", step.title);
    assignOptional(node, "run_if", step.run_if);
    assignOptional(node, "verify", step.verify);
    const origin = typeof step.input?.control_origin === "string" ? step.input.control_origin : undefined;
    assignOptional(node, "control_origin", origin);
    return node;
  });

  return {
    manifest_version: "dynamic_workflow/compiled/v1",
    workflow_id: originalPlan.workflow_id,
    nodes,
    dependencies,
    reverse_dependencies: reverseDependencies,
    ready_queue: nodes
      .filter((node) => node.depends_on.length === 0)
      .map((node) => node.step_id)
      .sort(),
    resource_locks: allLocks,
    writer_conflicts: writerConflicts(allLocks, dependencies),
    budget_summary: summarizeBudget(originalPlan.budget, originalPlan.steps.length, nodes.length),
    original_plan: structuredClone(originalPlan)
  };
}

interface ControlExpansion {
  entryStepIds: string[];
  terminalStepIds: string[];
}

function expandControlSteps(steps: WorkflowStep[], includeLibrary: Record<string, WorkflowStep[]>): WorkflowStep[] {
  const expanded: WorkflowStep[] = [];
  const controlExpansions = new Map<string, ControlExpansion>();
  for (const step of steps) {
    if (step.type === "workflow.include") {
      const included = expandInclude(step, includeLibrary);
      controlExpansions.set(step.step_id, summarizeControlExpansion(included));
      expanded.push(...included);
      continue;
    }
    if (step.type === "workflow.loop") {
      const rounds = expandLoop(step);
      controlExpansions.set(step.step_id, summarizeControlExpansion(rounds));
      expanded.push(...rounds);
      continue;
    }
    if (step.type === "workflow.tournament") {
      const judges = expandTournament(step);
      controlExpansions.set(step.step_id, summarizeControlExpansion(judges));
      expanded.push(...judges);
      continue;
    }
    expanded.push(structuredClone(step));
  }
  return rewriteControlReferences(expanded, controlExpansions);
}

function expandInclude(step: WorkflowStep, includeLibrary: Record<string, WorkflowStep[]>): WorkflowStep[] {
  const workflowRef = step.input?.workflow_ref ?? step.input?.ref;
  if (typeof workflowRef !== "string" || !Object.hasOwn(includeLibrary, workflowRef)) {
    throw new Error(`Unsupported workflow.include ref ${String(workflowRef)} for ${step.step_id}.`);
  }
  const includedSteps = includeLibrary[workflowRef];
  if (!includedSteps) {
    throw new Error(`Unsupported workflow.include ref ${workflowRef} for ${step.step_id}.`);
  }
  return includedSteps.map((included) => {
    const mappedId = `${step.step_id}__${included.step_id}`;
    const includedDependencies = included.depends_on.map((dependency) => `${step.step_id}__${dependency}`);
    const dependsOn = included.depends_on.length === 0 ? [...step.depends_on] : includedDependencies;
    const expanded: WorkflowStep = {
      ...structuredClone(included),
      step_id: mappedId,
      depends_on: dependsOn,
      input: {
        ...(included.input ?? {}),
        control_origin: step.step_id,
        workflow_ref: workflowRef
      }
    };
    assignOptional(expanded, "run_if", step.run_if ?? included.run_if);
    return expanded;
  });
}

function summarizeControlExpansion(steps: WorkflowStep[]): ControlExpansion {
  const allStepIds = new Set(steps.map((step) => step.step_id));
  const dependedOn = new Set(steps.flatMap((step) => step.depends_on).filter((dependency) => allStepIds.has(dependency)));
  const entryStepIds = steps.filter((step) => !step.depends_on.some((dependency) => allStepIds.has(dependency))).map((step) => step.step_id);
  const terminalStepIds = steps.filter((step) => !dependedOn.has(step.step_id)).map((step) => step.step_id);
  return { entryStepIds, terminalStepIds };
}

function rewriteControlReferences(
  steps: WorkflowStep[],
  controlExpansions: Map<string, ControlExpansion>
): WorkflowStep[] {
  return steps.map((step) => {
    const rewrittenDependencies = uniqueStrings(
      step.depends_on.flatMap((dependency) => terminalStepIdsFor(dependency, controlExpansions))
    );
    const rewrittenRunIf = rewriteRunIf(step.run_if, controlExpansions);
    const rewrittenInput = rewriteInputStepReferences(step.input, controlExpansions);
    if (
      arrayEquals(rewrittenDependencies, step.depends_on) &&
      rewrittenRunIf === step.run_if &&
      rewrittenInput === step.input
    ) {
      return step;
    }
    const rewritten: WorkflowStep = { ...step, depends_on: rewrittenDependencies };
    if (rewrittenRunIf !== undefined) {
      rewritten.run_if = rewrittenRunIf;
    }
    if (rewrittenInput !== undefined) {
      rewritten.input = rewrittenInput;
    }
    return rewritten;
  });
}

function arrayEquals(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function terminalStepIdsFor(stepId: string, controlExpansions: Map<string, ControlExpansion>): string[] {
  const expansion = controlExpansions.get(stepId);
  if (!expansion) return [stepId];
  if (expansion.terminalStepIds.length === 0) {
    throw new Error(`Compiled control ${stepId} did not produce any terminal nodes.`);
  }
  return expansion.terminalStepIds;
}

function singleTerminalStepIdFor(
  stepId: string,
  controlExpansions: Map<string, ControlExpansion>,
  context: string
): string {
  const terminalStepIds = terminalStepIdsFor(stepId, controlExpansions);
  if (terminalStepIds.length !== 1) {
    throw new Error(
      `Cannot rewrite ${context} reference ${stepId}; control expands to ${terminalStepIds.length} terminal nodes.`
    );
  }
  return terminalStepIds[0] as string;
}

function rewriteRunIf(
  runIf: RunCondition | undefined,
  controlExpansions: Map<string, ControlExpansion>
): RunCondition | undefined {
  if (!runIf || !controlExpansions.has(runIf.step)) return runIf;
  return { ...runIf, step: singleTerminalStepIdFor(runIf.step, controlExpansions, "run_if") };
}

function rewriteInputStepReferences(
  input: JsonObject | undefined,
  controlExpansions: Map<string, ControlExpansion>
): JsonObject | undefined {
  if (!input) return input;
  let rewritten: JsonObject | undefined;
  for (const key of ["candidate_a", "candidate_b"] as const) {
    const value = input[key];
    if (typeof value !== "string" || !controlExpansions.has(value)) continue;
    const terminalStepId = singleTerminalStepIdFor(value, controlExpansions, `input.${key}`);
    if (terminalStepId === value) continue;
    rewritten ??= { ...input };
    rewritten[key] = terminalStepId;
  }
  return rewritten ?? input;
}

function expandLoop(step: WorkflowStep): WorkflowStep[] {
  const maxRounds = step.input?.max_rounds;
  const stopCondition = step.input?.stop_condition;
  if (
    typeof maxRounds !== "number" ||
    !Number.isInteger(maxRounds) ||
    maxRounds <= 0 ||
    typeof stopCondition !== "string" ||
    stopCondition.trim() === ""
  ) {
    throw new Error(`Invalid workflow.loop ${step.step_id}; max_rounds and stop_condition are required.`);
  }
  const rounds: WorkflowStep[] = [];
  let previousRoundLast: string | undefined;
  for (let round = 1; round <= maxRounds; round += 1) {
    const roundStepId = `${step.step_id}__round_${round}`;
    const roundStep: WorkflowStep = {
      step_id: roundStepId,
      type: "agent.execute",
      permission_profile: "executor_writer",
      input: {
        prompt: `Execute loop round ${round} for ${step.step_id}.`,
        control_origin: step.step_id,
        loop_round: round,
        stop_condition: stopCondition
      },
      depends_on: previousRoundLast ? [previousRoundLast] : [...step.depends_on]
    };
    assignOptional(roundStep, "run_if", step.run_if);
    rounds.push(roundStep);
    previousRoundLast = roundStepId;
  }
  return rounds;
}

function expandTournament(step: WorkflowStep): WorkflowStep[] {
  const candidates = step.input?.candidate_steps;
  if (!Array.isArray(candidates) || candidates.some((candidate) => typeof candidate !== "string") || candidates.length < 2) {
    throw new Error(`Invalid workflow.tournament ${step.step_id}; candidate_steps requires at least two step ids.`);
  }
  const judgeType = step.input?.judge_type === "agent.judge_pair" ? "agent.judge_pair" : "agent.judge_pair";
  const candidateSet = new Set(candidates);
  const externalDependencies = step.depends_on.filter((dependency) => !candidateSet.has(dependency));
  const judges: WorkflowStep[] = [];
  let currentWinner = candidates[0] as string;
  for (let index = 1; index < candidates.length; index += 1) {
    const challenger = candidates[index] as string;
    const judgeId = `${step.step_id}__judge_${index}`;
    const judgeStep: WorkflowStep = {
      step_id: judgeId,
      type: judgeType,
      permission_profile: "reviewer_readonly",
      input: {
        candidate_a: currentWinner,
        candidate_b: challenger,
        criteria: Array.isArray(step.input?.criteria) ? step.input.criteria : [],
        control_origin: step.step_id
      },
      depends_on: uniqueStrings(index === 1 ? [...externalDependencies, currentWinner, challenger] : [currentWinner, challenger])
    };
    assignOptional(judgeStep, "run_if", step.run_if);
    judges.push(judgeStep);
    currentWinner = judgeId;
  }
  return judges;
}

function validateCompiledConditions(steps: WorkflowStep[]): void {
  const ids = new Set(steps.map((step) => step.step_id));
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!ids.has(dependency)) {
        throw new Error(`Compiled dependency in ${step.step_id} references missing step ${dependency}.`);
      }
    }
    if (step.run_if) {
      if (!ids.has(step.run_if.step)) {
        throw new Error(`Compiled run_if in ${step.step_id} references missing step ${step.run_if.step}.`);
      }
      if (!validateOutputPath(step.run_if.output_path)) {
        throw new Error(`Compiled run_if in ${step.step_id} has invalid output path ${step.run_if.output_path}.`);
      }
    }
  }
}

function buildReverseDependencies(steps: WorkflowStep[]): Record<string, string[]> {
  const reverse = Object.fromEntries(steps.map((step) => [step.step_id, [] as string[]]));
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      reverse[dependency]?.push(step.step_id);
    }
  }
  for (const dependents of Object.values(reverse)) {
    dependents.sort();
  }
  return reverse;
}

function summarizeBudget(budget: WorkflowBudget | undefined, declaredSteps: number, executableNodes: number): BudgetSummary {
  const summary: BudgetSummary = {
    declared_steps: declaredSteps,
    executable_nodes: executableNodes
  };
  assignOptional(summary, "max_steps", budget?.max_steps);
  assignOptional(summary, "max_subagents", budget?.max_subagents);
  assignOptional(summary, "max_rounds", budget?.max_rounds);
  assignOptional(summary, "max_minutes", budget?.max_minutes);
  return summary;
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
