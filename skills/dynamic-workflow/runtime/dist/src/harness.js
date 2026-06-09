import { compilePlan } from "./compiler.js";
export const HARNESS_ALLOWED_PRIMITIVES = [
    "agent",
    "command",
    "parallel",
    "pipeline",
    "loop",
    "judge",
    "artifact.read",
    "artifact.write",
    "askUser"
];
export const HARNESS_DENIED_CAPABILITIES = [
    "fs",
    "child_process",
    "process",
    "process.env",
    "fetch",
    "import",
    "import(",
    "require(",
    "eval(",
    "Function(",
    "new Function",
    "globalThis",
    "global",
    "window",
    "self",
    "constructor",
    "constructor.constructor",
    "computed_member_access"
];
const DENIED_RULES = [
    { capability: "fs", pattern: /\bfs\b/ },
    { capability: "child_process", pattern: /\bchild_process\b/ },
    { capability: "process.env", pattern: /\bprocess\b/ },
    { capability: "fetch", pattern: /\bfetch\b/ },
    { capability: "import", pattern: /\bimport\b/ },
    { capability: "require(", pattern: /\brequire\b/ },
    { capability: "eval(", pattern: /\beval\b/ },
    { capability: "new Function", pattern: /\bFunction\b/ },
    { capability: "globalThis", pattern: /\b(?:globalThis|global|window|self)\b/ },
    { capability: "constructor.constructor", pattern: /\.constructor\b/ },
    { capability: "computed_member_access", pattern: /(?:\)|\]|\b[A-Za-z_$][\w$]*)\s*\[[^\]]*\]/ }
];
export function compileHarnessToPlan(source, workflowId = "dwf_harness") {
    assertHarnessSourceAllowed(source);
    const steps = captureHarnessSteps(source);
    const plan = {
        schema_version: "dynamic_workflow/run/v1",
        workflow_id: workflowId,
        kind: "mixed",
        steps
    };
    return { plan, manifest: compilePlan(plan) };
}
export function assertHarnessSourceAllowed(source) {
    const code = stripStringsAndComments(source);
    rejectUnsupportedSyntax(code);
    for (const rule of DENIED_RULES) {
        if (rule.pattern.test(code)) {
            throw new Error(`Harness denied capability: ${rule.capability}`);
        }
    }
}
function rejectUnsupportedSyntax(code) {
    const unsupported = [
        { name: "if", pattern: /\bif\s*\(/ },
        { name: "for", pattern: /\bfor\s*\(/ },
        { name: "while", pattern: /\bwhile\s*\(/ },
        { name: "switch", pattern: /\bswitch\s*\(/ },
        { name: "try", pattern: /\btry\s*\{/ },
        { name: "class", pattern: /\bclass\s+[A-Za-z_$]/ }
    ];
    for (const rule of unsupported) {
        if (rule.pattern.test(code)) {
            throw new Error(`Harness unsupported syntax: ${rule.name}`);
        }
    }
}
function stripStringsAndComments(source) {
    let output = "";
    let index = 0;
    while (index < source.length) {
        const current = source[index];
        const next = source[index + 1];
        if (current === "/" && next === "/") {
            index += 2;
            while (index < source.length && source[index] !== "\n")
                index += 1;
            output += "\n";
            continue;
        }
        if (current === "/" && next === "*") {
            index += 2;
            while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
                index += 1;
            index += 2;
            output += " ";
            continue;
        }
        if (current === "\"" || current === "'") {
            const quote = current;
            output += `${quote}${quote}`;
            index += 1;
            while (index < source.length) {
                if (source[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (source[index] === quote) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        if (current === "`") {
            output += "``";
            index += 1;
            while (index < source.length) {
                if (source[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (source[index] === "$" && source[index + 1] === "{") {
                    throw new Error("Harness denied capability: template_expression");
                }
                if (source[index] === "`") {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        output += current;
        index += 1;
    }
    return output;
}
function captureHarnessSteps(source) {
    const captureSource = stripComments(source);
    if (usesDeclarativeDsl(captureSource)) {
        return captureDeclarativeSteps(captureSource);
    }
    const steps = [];
    const seenStepIds = new Map();
    let terminalStepIds = [];
    const parallelMatch = captureSource.match(/parallel\s*\(\s*\[([\s\S]*?)\]\s*\)/m);
    if (parallelMatch?.[1]) {
        const agents = parseAgentCalls(parallelMatch[1]);
        terminalStepIds = agents.map((agent, index) => {
            const stepId = uniqueStepId(agent.stepId ?? `agent_${index + 1}`, seenStepIds);
            steps.push({
                step_id: stepId,
                type: agent.type,
                permission_profile: agent.permissionProfile,
                input: { prompt: agent.prompt },
                depends_on: []
            });
            return stepId;
        });
    }
    const outsideParallel = captureSource.replace(/parallel\s*\(\s*\[[\s\S]*?\]\s*\)/gm, "");
    const agents = parseAgentCalls(outsideParallel);
    for (const agent of agents) {
        const stepId = uniqueStepId(agent.stepId ?? (agent.role === "synthesizer" ? "synthesize" : `agent_${steps.length + 1}`), seenStepIds);
        const dependsOn = agent.role === "synthesizer" ? [...terminalStepIds] : terminalStepIds.slice(-1);
        steps.push({
            step_id: stepId,
            type: agent.type,
            permission_profile: agent.permissionProfile,
            input: { prompt: agent.prompt },
            depends_on: dependsOn
        });
        terminalStepIds = [stepId];
    }
    const loopMatch = captureSource.match(/loop\s*\(([\s\S]*?)\)/m);
    if (loopMatch) {
        const stepId = uniqueStepId("loop", seenStepIds);
        steps.push({
            step_id: stepId,
            type: "workflow.loop",
            input: { max_rounds: 3, stop_condition: "done" },
            depends_on: terminalStepIds
        });
        terminalStepIds = [stepId];
    }
    const judgeMatch = captureSource.match(/judge\s*\(/m);
    if (judgeMatch && steps.length >= 2) {
        const candidateStepIds = terminalStepIds.length >= 2 ? terminalStepIds : steps.slice(0, 2).map((step) => step.step_id);
        const stepId = uniqueStepId("judge", seenStepIds);
        steps.push({
            step_id: stepId,
            type: "workflow.tournament",
            input: { candidate_steps: candidateStepIds, criteria: ["correctness"] },
            depends_on: candidateStepIds
        });
    }
    if (steps.length === 0) {
        throw new Error("Harness source did not contain supported workflow SDK calls.");
    }
    return steps;
}
function usesDeclarativeDsl(source) {
    return /\bcommand\s*\(/.test(source) || /\bagent\.(?:review|synthesize|execute)\s*\(/.test(source);
}
function captureDeclarativeSteps(source) {
    const steps = [];
    const handles = new Map();
    const seenStepIds = new Map();
    let position = 0;
    while (position < source.length) {
        const assignment = findNextDeclarativeAssignment(source, position);
        if (!assignment)
            break;
        const callEnd = findCallExpressionEnd(source, assignment.callStart);
        const args = source.slice(assignment.openParen + 1, callEnd - 1);
        const stepId = uniqueStepId(readFirstStringArg(args) ?? `${assignment.kind}_${steps.length + 1}`, seenStepIds);
        const options = readSecondObjectArg(args);
        const step = createDeclarativeStep(assignment.kind, stepId, options, handles);
        steps.push(step);
        if (assignment.variable) {
            handles.set(assignment.variable, { variable: assignment.variable, stepId });
        }
        position = callEnd;
    }
    if (steps.length === 0) {
        throw new Error("Harness source did not contain supported workflow SDK calls.");
    }
    return steps;
}
function findNextDeclarativeAssignment(source, start) {
    const pattern = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?(command|agent\.(?:review|synthesize|execute))\s*\(/gm;
    pattern.lastIndex = start;
    const match = pattern.exec(source);
    if (!match)
        return undefined;
    const kindText = match[2] ?? "";
    const kind = kindText === "command" ? "command" : kindText.slice("agent.".length);
    const assignment = {
        kind,
        callStart: match.index + match[0].lastIndexOf(kindText),
        openParen: pattern.lastIndex - 1
    };
    assignOptional(assignment, "variable", match[1]);
    return assignment;
}
function findCallExpressionEnd(source, callStart) {
    const openParen = source.indexOf("(", callStart);
    if (openParen === -1)
        throw new Error("Harness unsupported syntax: call_expression");
    let depth = 0;
    let index = openParen;
    while (index < source.length) {
        const char = source[index];
        if (char === "\"" || char === "'" || char === "`") {
            index = skipQuoted(source, index);
            continue;
        }
        if (char === "(")
            depth += 1;
        if (char === ")") {
            depth -= 1;
            if (depth === 0)
                return index + 1;
        }
        index += 1;
    }
    throw new Error("Harness unsupported syntax: unterminated_call");
}
function skipQuoted(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
        if (source[index] === "\\") {
            index += 2;
            continue;
        }
        if (source[index] === quote)
            return index + 1;
        index += 1;
    }
    return source.length;
}
function createDeclarativeStep(kind, stepId, options, handles) {
    if (kind === "command") {
        const commands = readStringArrayOption(options, "run");
        const produces = readProducesOption(options);
        const step = {
            step_id: stepId,
            type: "command.collect",
            permission_profile: "command_collector",
            input: { commands },
            depends_on: [],
            collect: { commands }
        };
        assignOptional(step, "produces", produces);
        return step;
    }
    const consumes = readContextConsumes(options, handles);
    const dependsOn = consumes.map((consume) => consume.from);
    const type = kind === "review" ? "agent.review" : kind === "synthesize" ? "agent.synthesize" : "agent.execute";
    const permissionProfile = type === "agent.review" ? "reviewer_readonly" : type === "agent.synthesize" ? "synthesizer" : "executor_writer";
    const step = {
        step_id: stepId,
        type,
        permission_profile: permissionProfile,
        input: { prompt: readOptionString(options, "prompt") ?? "" },
        depends_on: uniqueStepIds(dependsOn)
    };
    assignOptional(step, "consumes", consumes.length > 0 ? consumes : undefined);
    return step;
}
function readFirstStringArg(args) {
    return args.match(/^\s*["'`]([^"'`]+)["'`]/)?.[1];
}
function readSecondObjectArg(args) {
    const firstComma = findTopLevelComma(args);
    if (firstComma === -1)
        return "";
    const rest = args.slice(firstComma + 1).trim();
    if (!rest.startsWith("{"))
        return "";
    return rest.slice(1, findMatchingBrace(rest, 0));
}
function findTopLevelComma(value) {
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === "\"" || char === "'" || char === "`") {
            index = skipQuoted(value, index) - 1;
            continue;
        }
        if (char === "{" || char === "[" || char === "(")
            depth += 1;
        if (char === "}" || char === "]" || char === ")")
            depth -= 1;
        if (char === "," && depth === 0)
            return index;
    }
    return -1;
}
function findMatchingBrace(value, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < value.length; index += 1) {
        const char = value[index];
        if (char === "\"" || char === "'" || char === "`") {
            index = skipQuoted(value, index) - 1;
            continue;
        }
        if (char === "{")
            depth += 1;
        if (char === "}") {
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    throw new Error("Harness unsupported syntax: object_literal");
}
function readStringArrayOption(options, key) {
    const match = options.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`, "m"));
    if (!match?.[1])
        return [];
    return [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((entry) => entry[1] ?? "");
}
function readProducesOption(options) {
    const body = readObjectOption(options, "produces");
    if (!body)
        return undefined;
    const produces = {};
    for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        const name = match[1];
        const select = match[2];
        if (name && select)
            produces[name] = { select };
    }
    return Object.keys(produces).length > 0 ? produces : undefined;
}
function readContextConsumes(options, handles) {
    const body = readObjectOption(options, "context");
    if (!body)
        return [];
    const consumes = [];
    const contextPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_$][\w$]*)\.output\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    for (const match of body.matchAll(contextPattern)) {
        const alias = match[1];
        const handleName = match[2];
        const select = match[3];
        const handle = handleName ? handles.get(handleName) : undefined;
        if (!alias || !select || !handle) {
            throw new Error(`Harness unsupported syntax: context`);
        }
        consumes.push({ from: handle.stepId, select, as: alias });
    }
    return consumes;
}
function readObjectOption(options, key) {
    const pattern = new RegExp(`${key}\\s*:`, "m");
    const match = pattern.exec(options);
    if (!match)
        return undefined;
    const open = options.indexOf("{", match.index);
    if (open === -1)
        return undefined;
    return options.slice(open + 1, findMatchingBrace(options, open));
}
function uniqueStepIds(values) {
    return [...new Set(values)];
}
function stripComments(source) {
    let output = "";
    let index = 0;
    while (index < source.length) {
        const current = source[index];
        const next = source[index + 1];
        if (current === "/" && next === "/") {
            index += 2;
            while (index < source.length && source[index] !== "\n")
                index += 1;
            output += "\n";
            continue;
        }
        if (current === "/" && next === "*") {
            index += 2;
            output += " ";
            while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
                if (source[index] === "\n")
                    output += "\n";
                index += 1;
            }
            index += 2;
            continue;
        }
        if (current === "\"" || current === "'" || current === "`") {
            const quote = current;
            output += quote;
            index += 1;
            while (index < source.length) {
                const char = source[index];
                if (char === "\\") {
                    output += source.slice(index, index + 2);
                    index += 2;
                    continue;
                }
                output += char;
                index += 1;
                if (char === quote)
                    break;
            }
            continue;
        }
        output += current;
        index += 1;
    }
    return output;
}
function parseAgentCalls(source) {
    const calls = [];
    const agentPattern = /agent\s*\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/gm;
    for (const match of source.matchAll(agentPattern)) {
        const prompt = match[1] ?? "Agent step";
        const options = match[2] ?? "";
        const role = readOptionString(options, "role");
        const stepId = readOptionString(options, "step_id");
        const type = role === "synthesizer" ? "agent.synthesize" : role === "reviewer" ? "agent.review" : "agent.execute";
        const permissionProfile = type === "agent.synthesize" ? "synthesizer" : type === "agent.review" ? "reviewer_readonly" : "executor_writer";
        const parsed = { prompt, type, permissionProfile };
        assignOptional(parsed, "role", role);
        assignOptional(parsed, "stepId", stepId);
        calls.push(parsed);
    }
    return calls;
}
function readOptionString(options, key) {
    const pattern = new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`);
    return options.match(pattern)?.[1];
}
function uniqueStepId(stepId, seen) {
    const count = seen.get(stepId) ?? 0;
    seen.set(stepId, count + 1);
    return count === 0 ? stepId : `${stepId}_${count + 1}`;
}
function assignOptional(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}
//# sourceMappingURL=harness.js.map