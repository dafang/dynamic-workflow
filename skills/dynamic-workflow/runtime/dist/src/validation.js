import { isPermissionProfileName } from "./permissions.js";
import { getStepDefinition, isStepType } from "./registry.js";
import { HOST_LIMITS, SUPPORTED_BACKEND, SUPPORTED_SCHEMA_VERSION } from "./schema.js";
const CONDITION_OPS = new Set(["==", "!=", ">", ">=", "<", "<=", "exists", "not_exists"]);
const DATAFLOW_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRODUCE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SELECTOR_SEGMENT = "(?:[A-Za-z_][A-Za-z0-9_]*|\\*)";
const SELECTOR_PATTERN = new RegExp(`^\\$(?:\\.${SELECTOR_SEGMENT}(?:\\[\\*\\])?)*$`);
export function validatePlan(input) {
    const errors = [];
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
    const normalizedSteps = [];
    const seen = new Set();
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
        }
        else if (!definition.allowedPermissionProfiles.includes(profile)) {
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
        const inputObject = isRecord(rawStep.input) ? rawStep.input : undefined;
        const consumes = readConsumes(rawStep.consumes, `${path}.consumes`, stepId, errors);
        const produces = readProduces(rawStep.produces, `${path}.produces`, stepId, errors);
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
        if (rawType === "command.verify" || rawType === "command.collect") {
            validateCommandStepCommands(rawStep, path, stepId, rawType, errors);
        }
        const normalizedStep = {
            step_id: stepId,
            type: rawType,
            depends_on: dependsOn,
            permission_profile: isPermissionProfileName(profile) ? profile : definition.defaultPermissionProfile,
        };
        assignOptional(normalizedStep, "title", readOptionalString(rawStep, "title"));
        assignOptional(normalizedStep, "input", inputObject);
        assignOptional(normalizedStep, "consumes", consumes);
        assignOptional(normalizedStep, "produces", produces);
        assignOptional(normalizedStep, "backend", stepBackend === SUPPORTED_BACKEND ? stepBackend : undefined);
        assignOptional(normalizedStep, "budget", stepBudget);
        assignOptional(normalizedStep, "run_if", runIf);
        assignOptional(normalizedStep, "strategy", readOptionalString(rawStep, "strategy"));
        assignOptional(normalizedStep, "verify", readVerificationSpec(rawStep.verify, `${path}.verify`, stepId, errors));
        assignOptional(normalizedStep, "collect", readCommandCollectionSpec(rawStep.collect, `${path}.collect`, stepId, errors));
        normalizedSteps.push(normalizedStep);
    }
    validateReferences(normalizedSteps, errors);
    validateCycles(normalizedSteps, errors);
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    const plan = {
        schema_version: SUPPORTED_SCHEMA_VERSION,
        workflow_id: workflowId,
        kind,
        steps: normalizedSteps
    };
    assignOptional(plan, "scope_id", readOptionalString(input, "scope_id"));
    assignOptional(plan, "request", readOptionalString(input, "request"));
    assignOptional(plan, "backend", backend === SUPPORTED_BACKEND ? backend : undefined);
    assignOptional(plan, "budget", budget);
    assignOptional(plan, "metadata", isRecord(input.metadata) ? input.metadata : undefined);
    return {
        ok: true,
        plan,
        errors: []
    };
}
export function assertValidPlan(input) {
    const result = validatePlan(input);
    if (!result.ok) {
        const detail = result.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
        throw new Error(`Invalid dynamic workflow plan: ${detail}`);
    }
    return result.plan;
}
function readStepsArray(input, errors) {
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
function readString(object, key, errors, basePath = "") {
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
function readOptionalString(object, key) {
    const value = object[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function readStringArray(value, path, errors) {
    if (!Array.isArray(value)) {
        errors.push({ code: "invalid_string_array", message: `${path} must be an array of strings.`, path });
        return [];
    }
    const strings = [];
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
function readRunCondition(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
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
    const condition = {
        step,
        output_path: outputPath,
        op: CONDITION_OPS.has(op) ? op : "=="
    };
    assignOptional(condition, "value", isJsonValue(value.value) ? value.value : undefined);
    return condition;
}
function readBudget(value, path, errors, stepBudget) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        errors.push({ code: "invalid_budget", message: `${path} must be an object.`, path });
        return undefined;
    }
    const budget = {};
    const limits = {
        max_steps: HOST_LIMITS.max_steps,
        max_subagents: HOST_LIMITS.max_subagents,
        max_rounds: stepBudget ? HOST_LIMITS.step_max_rounds : HOST_LIMITS.max_rounds,
        max_minutes: stepBudget ? HOST_LIMITS.step_max_minutes : HOST_LIMITS.max_minutes,
        max_tokens: HOST_LIMITS.step_max_tokens
    };
    for (const key of Object.keys(limits)) {
        const max = limits[key];
        const current = value[key];
        if (current === undefined)
            continue;
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
function validateCommandStepCommands(rawStep, path, stepId, stepType, errors) {
    const inputCommands = isRecord(rawStep.input) ? rawStep.input.commands : undefined;
    const verifyCommands = isRecord(rawStep.verify) ? rawStep.verify.commands : undefined;
    const collectCommands = isRecord(rawStep.collect) ? rawStep.collect.commands : undefined;
    const commands = stepType === "command.verify" ? verifyCommands ?? inputCommands : collectCommands ?? inputCommands;
    if (!Array.isArray(commands) || commands.length === 0) {
        errors.push(withStepId({
            code: stepType === "command.verify" ? "missing_verify_commands" : "missing_collect_commands",
            message: stepType === "command.verify"
                ? "command.verify requires non-empty verify.commands or input.commands."
                : "command.collect requires non-empty collect.commands or input.commands.",
            path: stepType === "command.verify" ? `${path}.verify.commands` : `${path}.collect.commands`
        }, stepId));
        return;
    }
    readCommandDeclarations(commands, stepType === "command.verify" ? `${path}.verify.commands` : `${path}.collect.commands`, stepId, errors);
}
function readVerificationSpec(value, path, stepId, errors) {
    if (!isRecord(value))
        return undefined;
    const spec = {};
    const commands = readCommandDeclarations(value.commands, `${path}.commands`, stepId, errors);
    if (commands) {
        spec.commands = commands;
    }
    if (Array.isArray(value.required_artifacts) && value.required_artifacts.every((artifact) => typeof artifact === "string")) {
        spec.required_artifacts = value.required_artifacts;
    }
    if (isRecord(value.output_schema)) {
        spec.output_schema = value.output_schema;
    }
    return Object.keys(spec).length > 0 ? spec : undefined;
}
function readCommandCollectionSpec(value, path, stepId, errors) {
    if (!isRecord(value))
        return undefined;
    const commands = readCommandDeclarations(value.commands, `${path}.commands`, stepId, errors);
    return commands ? { commands } : undefined;
}
function readCommandDeclarations(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        errors.push(withStepId({ code: "invalid_command_list", message: `${path} must be an array.`, path }, stepId));
        return undefined;
    }
    const commands = [];
    for (const [index, rawCommand] of value.entries()) {
        const itemPath = `${path}[${index}]`;
        if (typeof rawCommand === "string") {
            if (rawCommand.trim() === "") {
                errors.push(withStepId({
                    code: "invalid_command",
                    message: `${itemPath} must be a non-empty command string.`,
                    path: itemPath
                }, stepId));
                continue;
            }
            commands.push(rawCommand);
            continue;
        }
        if (!isRecord(rawCommand)) {
            errors.push(withStepId({ code: "invalid_command", message: `${itemPath} must be a string or command object.`, path: itemPath }, stepId));
            continue;
        }
        const run = readString(rawCommand, "run", errors, itemPath);
        const command = { run };
        assignOptional(command, "id", readOptionalString(rawCommand, "id"));
        assignOptional(command, "allow_exit_codes", readExitCodes(rawCommand.allow_exit_codes, `${itemPath}.allow_exit_codes`, stepId, errors));
        if (rawCommand.soft_fail !== undefined && typeof rawCommand.soft_fail !== "boolean") {
            errors.push(withStepId({ code: "invalid_command_option", message: `${itemPath}.soft_fail must be boolean.`, path: `${itemPath}.soft_fail` }, stepId));
        }
        else {
            assignOptional(command, "soft_fail", rawCommand.soft_fail);
        }
        assignOptional(command, "timeout_seconds", readPositiveNumber(rawCommand.timeout_seconds, `${itemPath}.timeout_seconds`, stepId, errors));
        assignOptional(command, "stdout_max_bytes", readMaxBytes(rawCommand.stdout_max_bytes, `${itemPath}.stdout_max_bytes`, stepId, errors));
        assignOptional(command, "stderr_max_bytes", readMaxBytes(rawCommand.stderr_max_bytes, `${itemPath}.stderr_max_bytes`, stepId, errors));
        commands.push(command);
    }
    return commands;
}
function readExitCodes(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length === 0) {
        errors.push(withStepId({ code: "invalid_command_option", message: `${path} must be a non-empty array.`, path }, stepId));
        return undefined;
    }
    const exitCodes = [];
    for (const [index, exitCode] of value.entries()) {
        if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
            errors.push(withStepId({
                code: "invalid_command_option",
                message: `${path}[${index}] must be an integer from 0 to 255.`,
                path: `${path}[${index}]`
            }, stepId));
            continue;
        }
        exitCodes.push(exitCode);
    }
    return exitCodes;
}
function readPositiveNumber(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        errors.push(withStepId({ code: "invalid_command_option", message: `${path} must be a positive number.`, path }, stepId));
        return undefined;
    }
    return value;
}
function readConsumes(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        errors.push(withStepId({ code: "invalid_consumes", message: "consumes must be an array.", path }, stepId));
        return undefined;
    }
    const consumes = [];
    const aliases = new Set();
    for (const [index, rawConsume] of value.entries()) {
        const itemPath = `${path}[${index}]`;
        if (!isRecord(rawConsume)) {
            errors.push(withStepId({ code: "invalid_consume", message: "consume entry must be an object.", path: itemPath }, stepId));
            continue;
        }
        const from = readString(rawConsume, "from", errors, itemPath);
        const select = readString(rawConsume, "select", errors, itemPath);
        const alias = readString(rawConsume, "as", errors, itemPath);
        if (!DATAFLOW_ALIAS.test(alias)) {
            errors.push(withStepId({
                code: "invalid_consume_alias",
                message: `Consume alias ${alias} must match ${DATAFLOW_ALIAS.source}.`,
                path: `${itemPath}.as`
            }, stepId));
        }
        if (aliases.has(alias)) {
            errors.push(withStepId({
                code: "duplicate_consume_alias",
                message: `Duplicate consume alias ${alias}.`,
                path: `${itemPath}.as`
            }, stepId));
        }
        aliases.add(alias);
        if (!validateArtifactSelector(select)) {
            errors.push(withStepId({
                code: "invalid_artifact_selector",
                message: `Unsupported artifact selector ${select}.`,
                path: `${itemPath}.select`
            }, stepId));
        }
        const required = typeof rawConsume.required === "boolean" ? rawConsume.required : undefined;
        const maxBytes = readMaxBytes(rawConsume.max_bytes, `${itemPath}.max_bytes`, stepId, errors);
        const consume = { from, select, as: alias };
        assignOptional(consume, "required", required);
        assignOptional(consume, "max_bytes", maxBytes);
        consumes.push(consume);
    }
    return consumes;
}
function readProduces(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        errors.push(withStepId({ code: "invalid_produces", message: "produces must be an object.", path }, stepId));
        return undefined;
    }
    const produces = {};
    for (const [name, rawProduce] of Object.entries(value)) {
        const itemPath = `${path}.${name}`;
        if (!PRODUCE_NAME.test(name)) {
            errors.push(withStepId({
                code: "invalid_produce_name",
                message: `Produce name ${name} must match ${PRODUCE_NAME.source}.`,
                path: itemPath
            }, stepId));
        }
        if (!isRecord(rawProduce)) {
            errors.push(withStepId({ code: "invalid_produce", message: "produce entry must be an object.", path: itemPath }, stepId));
            continue;
        }
        const select = readString(rawProduce, "select", errors, itemPath);
        if (!validateArtifactSelector(select)) {
            errors.push(withStepId({
                code: "invalid_artifact_selector",
                message: `Unsupported artifact selector ${select}.`,
                path: `${itemPath}.select`
            }, stepId));
        }
        const produce = { select };
        assignOptional(produce, "schema", readOptionalString(rawProduce, "schema"));
        produces[name] = produce;
    }
    return Object.keys(produces).length > 0 ? produces : undefined;
}
function readMaxBytes(value, path, stepId, errors) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        errors.push(withStepId({ code: "invalid_max_bytes", message: `${path} must be a positive integer.`, path }, stepId));
        return undefined;
    }
    if (value > HOST_LIMITS.context_max_bytes) {
        errors.push(withStepId({
            code: "max_bytes_exceeds_host_limit",
            message: `${path}=${value} exceeds host maximum ${HOST_LIMITS.context_max_bytes}.`,
            path
        }, stepId));
        return undefined;
    }
    return value;
}
export function validateArtifactSelector(selector) {
    return SELECTOR_PATTERN.test(selector);
}
function validateReferences(steps, errors) {
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
        for (const consume of step.consumes ?? []) {
            if (!ids.has(consume.from)) {
                errors.push({
                    code: "unknown_consume_step",
                    message: `Step ${step.step_id} consumes from missing step ${consume.from}.`,
                    step_id: step.step_id,
                    path: `${step.step_id}.consumes`
                });
            }
            else if (!hasDependencyPath(step.step_id, consume.from, steps)) {
                errors.push({
                    code: "consume_not_upstream",
                    message: `Step ${step.step_id} consumes from ${consume.from}, which must be a dependency upstream.`,
                    step_id: step.step_id,
                    path: `${step.step_id}.consumes`
                });
            }
        }
    }
}
function hasDependencyPath(stepId, targetDependency, steps) {
    const byId = new Map(steps.map((step) => [step.step_id, step]));
    const visited = new Set();
    const stack = [...(byId.get(stepId)?.depends_on ?? [])];
    while (stack.length > 0) {
        const dependency = stack.pop();
        if (!dependency || visited.has(dependency))
            continue;
        if (dependency === targetDependency)
            return true;
        visited.add(dependency);
        stack.push(...(byId.get(dependency)?.depends_on ?? []));
    }
    return false;
}
function validateCycles(steps, errors) {
    const byId = new Map(steps.map((step) => [step.step_id, step]));
    const visiting = new Set();
    const visited = new Set();
    function visit(stepId, path) {
        if (visited.has(stepId))
            return;
        if (visiting.has(stepId)) {
            errors.push({
                code: "dependency_cycle",
                message: `Dependency cycle detected: ${[...path, stepId].join(" -> ")}.`,
                step_id: stepId
            });
            return;
        }
        const step = byId.get(stepId);
        if (!step)
            return;
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
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function withStepId(error, stepId) {
    return stepId ? { ...error, step_id: stepId } : error;
}
function assignOptional(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}
function isJsonValue(value) {
    if (value === null)
        return true;
    if (["string", "number", "boolean"].includes(typeof value))
        return true;
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (isRecord(value))
        return Object.values(value).every(isJsonValue);
    return false;
}
//# sourceMappingURL=validation.js.map