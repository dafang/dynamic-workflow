import { validateOutputPath } from "./conditions.js";
import { computeResourceLocks, writerConflicts } from "./resources.js";
import { assertValidPlan } from "./validation.js";
import { getStepDefinition } from "./registry.js";
const DEFAULT_INCLUDE_LIBRARY = {
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
export function compilePlan(input, options = {}) {
    const originalPlan = assertValidPlan(input);
    const includeLibrary = options.includeLibrary ?? DEFAULT_INCLUDE_LIBRARY;
    const expandedSteps = expandControlSteps(originalPlan.steps, includeLibrary);
    validateCompiledConditions(expandedSteps);
    const dependencies = Object.fromEntries(expandedSteps.map((step) => [step.step_id, [...step.depends_on].sort()]));
    const reverseDependencies = buildReverseDependencies(expandedSteps);
    const allLocks = computeResourceLocks(expandedSteps);
    const locksByStep = new Map();
    for (const lock of allLocks) {
        locksByStep.set(lock.step_id, [...(locksByStep.get(lock.step_id) ?? []), lock]);
    }
    const nodes = expandedSteps.map((step) => {
        const node = {
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
function expandControlSteps(steps, includeLibrary) {
    const expanded = [];
    const controlExpansions = new Map();
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
function expandInclude(step, includeLibrary) {
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
        const expanded = {
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
function summarizeControlExpansion(steps) {
    const allStepIds = new Set(steps.map((step) => step.step_id));
    const dependedOn = new Set(steps.flatMap((step) => step.depends_on).filter((dependency) => allStepIds.has(dependency)));
    const entryStepIds = steps.filter((step) => !step.depends_on.some((dependency) => allStepIds.has(dependency))).map((step) => step.step_id);
    const terminalStepIds = steps.filter((step) => !dependedOn.has(step.step_id)).map((step) => step.step_id);
    return { entryStepIds, terminalStepIds };
}
function rewriteControlReferences(steps, controlExpansions) {
    return steps.map((step) => {
        const rewrittenDependencies = uniqueStrings(step.depends_on.flatMap((dependency) => terminalStepIdsFor(dependency, controlExpansions)));
        const rewrittenRunIf = rewriteRunIf(step.run_if, controlExpansions);
        const rewrittenConsumes = rewriteConsumes(step.consumes, controlExpansions);
        const rewrittenInput = rewriteInputStepReferences(step.input, controlExpansions);
        if (arrayEquals(rewrittenDependencies, step.depends_on) &&
            rewrittenRunIf === step.run_if &&
            rewrittenConsumes === step.consumes &&
            rewrittenInput === step.input) {
            return step;
        }
        const rewritten = { ...step, depends_on: rewrittenDependencies };
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
function arrayEquals(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function uniqueStrings(values) {
    return [...new Set(values)];
}
function terminalStepIdsFor(stepId, controlExpansions) {
    const expansion = controlExpansions.get(stepId);
    if (!expansion)
        return [stepId];
    if (expansion.terminalStepIds.length === 0) {
        throw new Error(`Compiled control ${stepId} did not produce any terminal nodes.`);
    }
    return expansion.terminalStepIds;
}
function singleTerminalStepIdFor(stepId, controlExpansions, context) {
    const terminalStepIds = terminalStepIdsFor(stepId, controlExpansions);
    if (terminalStepIds.length !== 1) {
        throw new Error(`Cannot rewrite ${context} reference ${stepId}; control expands to ${terminalStepIds.length} terminal nodes.`);
    }
    return terminalStepIds[0];
}
function rewriteRunIf(runIf, controlExpansions) {
    if (!runIf || !controlExpansions.has(runIf.step))
        return runIf;
    return { ...runIf, step: singleTerminalStepIdFor(runIf.step, controlExpansions, "run_if") };
}
function rewriteConsumes(consumes, controlExpansions) {
    if (!consumes)
        return consumes;
    let rewritten;
    consumes.forEach((consume, index) => {
        if (!controlExpansions.has(consume.from))
            return;
        rewritten ??= consumes.map((entry) => ({ ...entry }));
        rewritten[index] = {
            ...consume,
            from: singleTerminalStepIdFor(consume.from, controlExpansions, "consumes.from")
        };
    });
    return rewritten ?? consumes;
}
function rewriteInputStepReferences(input, controlExpansions) {
    if (!input)
        return input;
    let rewritten;
    for (const key of ["candidate_a", "candidate_b"]) {
        const value = input[key];
        if (typeof value !== "string" || !controlExpansions.has(value))
            continue;
        const terminalStepId = singleTerminalStepIdFor(value, controlExpansions, `input.${key}`);
        if (terminalStepId === value)
            continue;
        rewritten ??= { ...input };
        rewritten[key] = terminalStepId;
    }
    return rewritten ?? input;
}
function expandLoop(step) {
    const maxRounds = step.input?.max_rounds;
    const stopCondition = step.input?.stop_condition;
    if (typeof maxRounds !== "number" ||
        !Number.isInteger(maxRounds) ||
        maxRounds <= 0 ||
        typeof stopCondition !== "string" ||
        stopCondition.trim() === "") {
        throw new Error(`Invalid workflow.loop ${step.step_id}; max_rounds and stop_condition are required.`);
    }
    const body = Array.isArray(step.input?.body) ? readLoopBody(step.input.body, step.step_id) : undefined;
    if (body && body.length > 0) {
        return expandLoopBody(step, body, maxRounds, stopCondition);
    }
    const rounds = [];
    let previousRoundLast;
    for (let round = 1; round <= maxRounds; round += 1) {
        const roundStepId = `${step.step_id}__round_${round}`;
        const roundStep = {
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
function readLoopBody(body, loopStepId) {
    if (!Array.isArray(body)) {
        return [];
    }
    return body.map((rawStep, index) => {
        if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
            throw new Error(`Invalid workflow.loop ${loopStepId}; body[${index}] must be a step object.`);
        }
        const candidate = rawStep;
        if (typeof candidate.step_id !== "string" ||
            typeof candidate.type !== "string" ||
            !Array.isArray(candidate.depends_on)) {
            throw new Error(`Invalid workflow.loop ${loopStepId}; body[${index}] requires step_id, type, and depends_on.`);
        }
        return structuredClone(candidate);
    });
}
function expandLoopBody(step, body, maxRounds, stopCondition) {
    const rounds = [];
    const bodyIds = new Set(body.map((bodyStep) => bodyStep.step_id));
    if (bodyIds.size !== body.length) {
        throw new Error(`Invalid workflow.loop ${step.step_id}; body step ids must be unique.`);
    }
    const dependedOn = new Set();
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
    let previousTerminalStepId;
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
            const expanded = {
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
            const rewrittenConsumes = rewriteLoopBodyConsumes(bodyStep.consumes, step.step_id, round, bodyIds, previousRoundTerminal);
            assignOptional(expanded, "consumes", rewrittenConsumes);
            assignOptional(expanded, "run_if", loopBodyRunIf(step, bodyStep, round, bodyIds, until, previousRoundTerminal));
            rounds.push(expanded);
        }
        previousTerminalStepId = loopBodyStepId(step.step_id, round, terminalBodyStepId);
    }
    return rounds;
}
function loopBodyStepId(loopStepId, round, bodyStepId) {
    return `${loopStepId}__round_${round}__${bodyStepId}`;
}
function rewriteLoopBodyConsumes(consumes, loopStepId, round, bodyIds, previousRoundTerminal) {
    if (!consumes)
        return consumes;
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
    }).filter((consume) => consume !== undefined);
}
function loopBodyRunIf(loopStep, bodyStep, round, bodyIds, until, previousRoundTerminal) {
    const bodyRunIf = rewriteLoopBodyRunCondition(bodyStep.run_if, loopStep.step_id, round, bodyIds, previousRoundTerminal);
    if (loopStep.run_if && bodyRunIf) {
        throw new Error(`Invalid workflow.loop ${loopStep.step_id}; run_if cannot be set on both the loop and body step ${bodyStep.step_id}.`);
    }
    const baseRunIf = loopStep.run_if ?? bodyRunIf;
    if (round === 1 || !until || !previousRoundTerminal) {
        return baseRunIf;
    }
    if (baseRunIf) {
        throw new Error(`Invalid workflow.loop ${loopStep.step_id}; input.until cannot be combined with run_if on the loop or body entry step ${bodyStep.step_id}.`);
    }
    const continueCondition = {
        step: previousRoundTerminal,
        output_path: until.output_path,
        op: negateConditionOp(until.op)
    };
    assignOptional(continueCondition, "value", until.value);
    return baseRunIf ?? continueCondition;
}
function rewriteLoopBodyRunCondition(runIf, loopStepId, round, bodyIds, previousRoundTerminal) {
    if (!runIf)
        return undefined;
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
function readLoopUntil(step) {
    const until = step.input?.until;
    if (typeof until !== "object" || until === null || Array.isArray(until)) {
        return undefined;
    }
    const candidate = until;
    const outputPath = typeof candidate.output_path === "string" ? candidate.output_path : undefined;
    const op = typeof candidate.op === "string" ? candidate.op : undefined;
    if (!outputPath || !op) {
        return undefined;
    }
    if (!isNegatableConditionOp(op)) {
        throw new Error(`Invalid workflow.loop ${step.step_id}; input.until op ${op} cannot be safely negated.`);
    }
    const condition = {
        step: "",
        output_path: outputPath,
        op: op
    };
    assignOptional(condition, "value", candidate.value);
    return condition;
}
function negateConditionOp(op) {
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
function isNegatableConditionOp(op) {
    return op === "==" || op === "!=" || op === "exists" || op === "not_exists";
}
function isString(value) {
    return typeof value === "string";
}
function expandTournament(step) {
    const candidates = step.input?.candidate_steps;
    if (!Array.isArray(candidates) || candidates.some((candidate) => typeof candidate !== "string") || candidates.length < 2) {
        throw new Error(`Invalid workflow.tournament ${step.step_id}; candidate_steps requires at least two step ids.`);
    }
    const judgeType = step.input?.judge_type === "agent.judge_pair" ? "agent.judge_pair" : "agent.judge_pair";
    const candidateSet = new Set(candidates);
    const externalDependencies = step.depends_on.filter((dependency) => !candidateSet.has(dependency));
    const judges = [];
    let currentWinner = candidates[0];
    for (let index = 1; index < candidates.length; index += 1) {
        const challenger = candidates[index];
        const judgeId = `${step.step_id}__judge_${index}`;
        const judgeStep = {
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
function inheritedControlInput(step) {
    const resourceScope = step.input?.resource_scope;
    return typeof resourceScope === "string" && resourceScope.trim() !== "" ? { resource_scope: resourceScope } : {};
}
function validateCompiledConditions(steps) {
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
function buildReverseDependencies(steps) {
    const reverse = Object.fromEntries(steps.map((step) => [step.step_id, []]));
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
function summarizeBudget(budget, declaredSteps, executableNodes) {
    const summary = {
        declared_steps: declaredSteps,
        executable_nodes: executableNodes
    };
    assignOptional(summary, "max_steps", budget?.max_steps);
    assignOptional(summary, "max_subagents", budget?.max_subagents);
    assignOptional(summary, "max_rounds", budget?.max_rounds);
    assignOptional(summary, "max_minutes", budget?.max_minutes);
    return summary;
}
function assignOptional(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}
//# sourceMappingURL=compiler.js.map