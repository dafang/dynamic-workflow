import { validateOutputPath } from "./conditions.js";
import { computeResourceLocks, writerConflicts, type ResourceLock } from "./resources.js";
import { assertValidPlan } from "./validation.js";
import { getStepDefinition } from "./registry.js";
import type {
  JsonObject,
  CommandCollectionSpec,
  RunCondition,
  StepConsume,
  StepProduces,
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
  consumes?: StepConsume[];
  produces?: StepProduces;
  permission_profile: string;
  backend: "current";
  run_if?: RunCondition;
  verify?: VerificationSpec;
  collect?: CommandCollectionSpec;
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
  manifest_version: "dynamic_workflow/compiled/v2";
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
      permission_profile: step.permission_profile ?? getStepDefinition(step.type).defaultPermissionProfile,
      backend: "current",
      resource_locks: locksByStep.get(step.step_id) ?? []
    };
    assignOptional(node, "title", step.title);
    assignOptional(node, "consumes", step.consumes);
    assignOptional(node, "produces", step.produces);
    assignOptional(node, "run_if", step.run_if);
    assignOptional(node, "verify", step.verify);
    assignOptional(node, "collect", step.collect);
    const origin = typeof step.input?.control_origin === "string" ? step.input.control_origin : undefined;
    assignOptional(node, "control_origin", origin);
    return node;
  });

  return {
    manifest_version: "dynamic_workflow/compiled/v2",
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
        ...inheritedControlInput(step),
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
    const rewrittenConsumes = rewriteConsumes(step.consumes, controlExpansions);
    const rewrittenInput = rewriteInputStepReferences(step.input, controlExpansions);
    if (
      arrayEquals(rewrittenDependencies, step.depends_on) &&
      rewrittenRunIf === step.run_if &&
      rewrittenConsumes === step.consumes &&
      rewrittenInput === step.input
    ) {
      return step;
    }
    const rewritten: WorkflowStep = { ...step, depends_on: rewrittenDependencies };
    if (rewrittenRunIf !== undefined) {
      rewritten.run_if = rewrittenRunIf;
    }
    if (rewrittenConsumes !== undefined) {
      rewritten.consumes = rewrittenConsumes;
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

function rewriteConsumes(
  consumes: StepConsume[] | undefined,
  controlExpansions: Map<string, ControlExpansion>
): StepConsume[] | undefined {
  if (!consumes) return consumes;
  let rewritten: StepConsume[] | undefined;
  consumes.forEach((consume, index) => {
    if (!controlExpansions.has(consume.from)) return;
    rewritten ??= consumes.map((entry) => ({ ...entry }));
    rewritten[index] = {
      ...consume,
      from: singleTerminalStepIdFor(consume.from, controlExpansions, "consumes.from")
    };
  });
  return rewritten ?? consumes;
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
  const body = Array.isArray(step.input?.body) ? readLoopBody(step.input.body, step.step_id) : undefined;
  if (body && body.length > 0) {
    return expandLoopBody(step, body, maxRounds, stopCondition);
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
        ...inheritedControlInput(step),
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

function readLoopBody(body: JsonObject["body"], loopStepId: string): WorkflowStep[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.map((rawStep, index) => {
    if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
      throw new Error(`Invalid workflow.loop ${loopStepId}; body[${index}] must be a step object.`);
    }
    const candidate = rawStep as Partial<WorkflowStep>;
    if (
      typeof candidate.step_id !== "string" ||
      typeof candidate.type !== "string" ||
      !Array.isArray(candidate.depends_on)
    ) {
      throw new Error(`Invalid workflow.loop ${loopStepId}; body[${index}] requires step_id, type, and depends_on.`);
    }
    return structuredClone(candidate as WorkflowStep);
  });
}

function expandLoopBody(
  step: WorkflowStep,
  body: WorkflowStep[],
  maxRounds: number,
  stopCondition: string
): WorkflowStep[] {
  const rounds: WorkflowStep[] = [];
  const bodyIds = new Set(body.map((bodyStep) => bodyStep.step_id));
  if (bodyIds.size !== body.length) {
    throw new Error(`Invalid workflow.loop ${step.step_id}; body step ids must be unique.`);
  }
  const dependedOn = new Set<string>();
  for (const bodyStep of body) {
    for (const dependency of bodyStep.depends_on) {
      if (bodyIds.has(dependency)) {
        dependedOn.add(dependency);
      }
    }
  }
  const terminalBodySteps = body.filter((bodyStep) => !dependedOn.has(bodyStep.step_id));
  if (terminalBodySteps.length === 0) {
    throw new Error(`Invalid workflow.loop ${step.step_id}; body must have at least one terminal step.`);
  }
  if (terminalBodySteps.length > 1) {
    throw new Error(`Invalid workflow.loop ${step.step_id}; body must have a single terminal step.`);
  }
  const terminalBodyStepId = terminalBodySteps[0]?.step_id;
  if (!terminalBodyStepId) {
    throw new Error(`Invalid workflow.loop ${step.step_id}; body terminal step could not be determined.`);
  }

  const until = readLoopUntil(step);
  let previousTerminalStepId: string | undefined;
  for (let round = 1; round <= maxRounds; round += 1) {
    const previousRoundTerminal = previousTerminalStepId;
    for (const bodyStep of body) {
      const mappedId = loopBodyStepId(step.step_id, round, bodyStep.step_id);
      const internalDependencies = bodyStep.depends_on.filter((dependency) => bodyIds.has(dependency));
      const externalDependencies = bodyStep.depends_on.filter((dependency) => !bodyIds.has(dependency));
      const dependsOn = uniqueStrings([
        ...internalDependencies.map((dependency) => loopBodyStepId(step.step_id, round, dependency)),
        ...externalDependencies,
        ...(internalDependencies.length === 0 ? round === 1 ? step.depends_on : [previousRoundTerminal].filter(isString) : [])
      ]);
      const expanded: WorkflowStep = {
        ...structuredClone(bodyStep),
        step_id: mappedId,
        depends_on: dependsOn,
        input: {
          ...inheritedControlInput(step),
          ...(bodyStep.input ?? {}),
          control_origin: step.step_id,
          loop_round: round,
          stop_condition: stopCondition
        }
      };
      const rewrittenConsumes = rewriteLoopBodyConsumes(
        bodyStep.consumes,
        step.step_id,
        round,
        bodyIds,
        previousRoundTerminal
      );
      assignOptional(expanded, "consumes", rewrittenConsumes);
      assignOptional(expanded, "run_if", loopBodyRunIf(step, bodyStep, round, bodyIds, until, previousRoundTerminal));
      rounds.push(expanded);
    }
    previousTerminalStepId = loopBodyStepId(step.step_id, round, terminalBodyStepId);
  }
  return rounds;
}

function loopBodyStepId(loopStepId: string, round: number, bodyStepId: string): string {
  return `${loopStepId}__round_${round}__${bodyStepId}`;
}

function rewriteLoopBodyConsumes(
  consumes: StepConsume[] | undefined,
  loopStepId: string,
  round: number,
  bodyIds: Set<string>,
  previousRoundTerminal: string | undefined
): StepConsume[] | undefined {
  if (!consumes) return consumes;
  return consumes.map((consume) => {
    if (bodyIds.has(consume.from)) {
      return { ...consume, from: loopBodyStepId(loopStepId, round, consume.from) };
    }
    if (consume.from === "$previous" || consume.from === "previous_round") {
      if (!previousRoundTerminal) {
        return undefined;
      }
      return { ...consume, from: previousRoundTerminal };
    }
    return { ...consume };
  }).filter((consume): consume is StepConsume => consume !== undefined);
}

function loopBodyRunIf(
  loopStep: WorkflowStep,
  bodyStep: WorkflowStep,
  round: number,
  bodyIds: Set<string>,
  until: RunCondition | undefined,
  previousRoundTerminal: string | undefined
): RunCondition | undefined {
  const bodyRunIf = rewriteLoopBodyRunCondition(bodyStep.run_if, loopStep.step_id, round, bodyIds, previousRoundTerminal);
  if (loopStep.run_if && bodyRunIf) {
    throw new Error(
      `Invalid workflow.loop ${loopStep.step_id}; run_if cannot be set on both the loop and body step ${bodyStep.step_id}.`
    );
  }
  const baseRunIf = loopStep.run_if ?? bodyRunIf;
  if (round === 1 || !until || !previousRoundTerminal) {
    return baseRunIf;
  }
  if (baseRunIf) {
    throw new Error(
      `Invalid workflow.loop ${loopStep.step_id}; input.until cannot be combined with run_if on the loop or body entry step ${bodyStep.step_id}.`
    );
  }
  const continueCondition: RunCondition = {
    step: previousRoundTerminal,
    output_path: until.output_path,
    op: negateConditionOp(until.op)
  };
  assignOptional(continueCondition, "value", until.value);
  return baseRunIf ?? continueCondition;
}

function rewriteLoopBodyRunCondition(
  runIf: RunCondition | undefined,
  loopStepId: string,
  round: number,
  bodyIds: Set<string>,
  previousRoundTerminal: string | undefined
): RunCondition | undefined {
  if (!runIf) return undefined;
  if (bodyIds.has(runIf.step)) {
    return { ...runIf, step: loopBodyStepId(loopStepId, round, runIf.step) };
  }
  if (runIf.step === "$previous" || runIf.step === "previous_round") {
    if (!previousRoundTerminal) {
      return undefined;
    }
    return { ...runIf, step: previousRoundTerminal };
  }
  return { ...runIf };
}

function readLoopUntil(step: WorkflowStep): RunCondition | undefined {
  const until = step.input?.until;
  if (typeof until !== "object" || until === null || Array.isArray(until)) {
    return undefined;
  }
  const candidate = until as JsonObject;
  const outputPath = typeof candidate.output_path === "string" ? candidate.output_path : undefined;
  const op = typeof candidate.op === "string" ? candidate.op : undefined;
  if (!outputPath || !op) {
    return undefined;
  }
  if (!isNegatableConditionOp(op)) {
    throw new Error(`Invalid workflow.loop ${step.step_id}; input.until op ${op} cannot be safely negated.`);
  }
  const condition: RunCondition = {
    step: "",
    output_path: outputPath,
    op: op as RunCondition["op"]
  };
  assignOptional(condition, "value", candidate.value);
  return condition;
}

function negateConditionOp(op: RunCondition["op"]): RunCondition["op"] {
  switch (op) {
    case "==":
      return "!=";
    case "!=":
      return "==";
    case "exists":
      return "not_exists";
    case "not_exists":
      return "exists";
    default:
      throw new Error(`Cannot negate condition operator ${op}.`);
  }
}

function isNegatableConditionOp(op: string): op is "==" | "!=" | "exists" | "not_exists" {
  return op === "==" || op === "!=" || op === "exists" || op === "not_exists";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
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
        ...inheritedControlInput(step),
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

function inheritedControlInput(step: WorkflowStep): JsonObject {
  const resourceScope = step.input?.resource_scope;
  return typeof resourceScope === "string" && resourceScope.trim() !== "" ? { resource_scope: resourceScope } : {};
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
    for (const consume of step.consumes ?? []) {
      if (!ids.has(consume.from)) {
        throw new Error(`Compiled consume in ${step.step_id} references missing step ${consume.from}.`);
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
