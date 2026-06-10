import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAgentOutputInstructions, isAgentStepType } from "../agent-contracts.js";
const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_CAP_BYTES = 2_000;
const COMMAND_PREVIEW_LENGTH = 160;
const DEFAULT_PASEO_WAIT_TIMEOUT = "30m";
export class CurrentBackend {
    name = "current";
    async executeStep(node, context) {
        if (node.type === "human.approval") {
            return {
                status: "waiting_user",
                summary: "Waiting for human approval.",
                output: { status: "waiting_user", step_id: node.step_id }
            };
        }
        if (node.type === "command.verify" || node.type === "command.collect") {
            return executeCommands(node, context);
        }
        if (node.input.force_fail === true) {
            return {
                status: "failed",
                summary: `Step ${node.step_id} failed by fixture request.`,
                output: { status: "failed", step_id: node.step_id, reason: "force_fail" }
            };
        }
        if (node.input.agent_backend === "paseo") {
            return executePaseoAgent(node, context);
        }
        const summary = `Executed ${node.step_id} through current host boundary.`;
        return {
            status: "succeeded",
            summary,
            output: buildCurrentAgentOutput(node, context, summary)
        };
    }
}
async function executePaseoAgent(node, context) {
    const prompt = agentPrompt(node, context);
    const cwd = stringInput(node, "cwd") ?? process.cwd();
    const provider = stringInput(node, "provider") ?? process.env.DW_PASEO_PROVIDER ?? "codex/gpt-5.5";
    const mode = stringInput(node, "mode") ?? process.env.DW_PASEO_MODE ?? "full-access";
    const title = stringInput(node, "title") ?? `DW ${node.step_id}`;
    const waitTimeout = stringInput(node, "wait_timeout") ?? DEFAULT_PASEO_WAIT_TIMEOUT;
    const paseoCli = stringInput(node, "paseo_cli") ?? process.env.DW_PASEO_CLI ?? "paseo";
    const args = [
        "run",
        "--json",
        "--provider",
        provider,
        "--mode",
        mode,
        "--cwd",
        cwd,
        "--title",
        title,
        "--wait-timeout",
        waitTimeout,
        prompt
    ];
    const start = Date.now();
    await context.trace?.({
        event: "agent_backend_started",
        data: {
            backend: "paseo",
            provider,
            mode,
            cwd,
            title,
            wait_timeout: waitTimeout
        }
    });
    try {
        const { stdout, stderr } = await execFileAsync(paseoCli, args, { timeout: paseoTimeoutMs(waitTimeout) + 5_000 });
        let parsed;
        try {
            parsed = parsePaseoRunOutput(stdout);
        }
        catch (error) {
            const elapsedMs = Date.now() - start;
            await context.trace?.({
                event: "agent_output_parse_failed",
                data: {
                    backend: "paseo",
                    elapsed_ms: elapsedMs,
                    stdout_bytes: Buffer.byteLength(stdout, "utf8"),
                    stderr_bytes: Buffer.byteLength(stderr ?? "", "utf8")
                }
            });
            return {
                status: "failed",
                summary: `Paseo agent output could not be parsed for ${node.step_id}: ${error.message}`,
                output: {
                    status: "failed",
                    step_id: node.step_id,
                    type: node.type,
                    agent_backend: "paseo",
                    reason: "agent_output_parse_failed",
                    stdout: clipTail(stdout, DEFAULT_OUTPUT_CAP_BYTES).value,
                    stderr: clipTail(stderr ?? "", DEFAULT_OUTPUT_CAP_BYTES).value
                }
            };
        }
        if (!parsed.structuredOutput && parsed.agentId) {
            const logsOutput = await readPaseoStructuredOutputFromLogs(paseoCli, parsed.agentId, node, context);
            if (logsOutput) {
                parsed.structuredOutput = logsOutput;
            }
        }
        const elapsedMs = Date.now() - start;
        const traceData = {
            backend: "paseo",
            elapsed_ms: elapsedMs,
            stdout_bytes: Buffer.byteLength(stdout, "utf8"),
            stderr_bytes: Buffer.byteLength(stderr ?? "", "utf8")
        };
        assignJsonOptional(traceData, "agent_id", parsed.agentId);
        assignJsonOptional(traceData, "status", parsed.status);
        await context.trace?.({
            event: "agent_backend_finished",
            data: traceData
        });
        const succeeded = parsed.status === "completed" || parsed.status === "idle" || parsed.status === "succeeded";
        const output = {
            ...(parsed.structuredOutput ?? {}),
            status: succeeded ? "succeeded" : "failed",
            step_id: node.step_id,
            type: node.type,
            agent_backend: "paseo",
            agent_id: parsed.agentId ?? "",
            agent_status: parsed.status ?? "unknown",
            provider: parsed.provider ?? provider,
            cwd: parsed.cwd ?? cwd,
            title: parsed.title ?? title,
            elapsed_ms: elapsedMs,
            context: context.inputs,
            context_sources: context.sources.map((source) => ({ ...source })),
            stderr: clipTail(stderr ?? "", DEFAULT_OUTPUT_CAP_BYTES).value
        };
        return {
            status: succeeded ? "succeeded" : "failed",
            summary: succeeded
                ? `Paseo agent ${parsed.agentId ?? "unknown"} completed ${node.step_id}.`
                : `Paseo agent ${parsed.agentId ?? "unknown"} ended with status ${parsed.status ?? "unknown"}.`,
            output
        };
    }
    catch (error) {
        const failed = error;
        const elapsedMs = Date.now() - start;
        await context.trace?.({
            event: "agent_backend_failed",
            data: {
                backend: "paseo",
                elapsed_ms: elapsedMs,
                exit_code: typeof failed.code === "number" ? failed.code : null,
                signal: typeof failed.signal === "string" ? failed.signal : null,
                stdout_bytes: Buffer.byteLength(failed.stdout ?? "", "utf8"),
                stderr_bytes: Buffer.byteLength(failed.stderr ?? failed.message, "utf8")
            }
        });
        return {
            status: "failed",
            summary: `Paseo agent backend failed for ${node.step_id}: ${failed.message}`,
            output: {
                status: "failed",
                step_id: node.step_id,
                type: node.type,
                agent_backend: "paseo",
                reason: "agent_backend_failed",
                exit_code: typeof failed.code === "number" ? failed.code : null,
                signal: typeof failed.signal === "string" ? failed.signal : null,
                stdout: clipTail(failed.stdout ?? "", DEFAULT_OUTPUT_CAP_BYTES).value,
                stderr: clipTail(failed.stderr ?? failed.message, DEFAULT_OUTPUT_CAP_BYTES).value
            }
        };
    }
}
async function readPaseoStructuredOutputFromLogs(paseoCli, agentId, node, context) {
    try {
        const { stdout, stderr } = await execFileAsync(paseoCli, ["logs", "--json", agentId], {
            timeout: 30_000,
            maxBuffer: DEFAULT_OUTPUT_CAP_BYTES * 16
        });
        const structuredOutput = extractStructuredOutputFromText(stdout);
        await context.trace?.({
            event: structuredOutput ? "agent_output_logs_parsed" : "agent_output_logs_missing",
            data: {
                backend: "paseo",
                agent_id: agentId,
                step_type: node.type,
                stdout_bytes: Buffer.byteLength(stdout, "utf8"),
                stderr_bytes: Buffer.byteLength(stderr ?? "", "utf8")
            }
        });
        return structuredOutput;
    }
    catch (error) {
        const failed = error;
        await context.trace?.({
            event: "agent_output_logs_failed",
            data: {
                backend: "paseo",
                agent_id: agentId,
                step_type: node.type,
                exit_code: typeof failed.code === "number" ? failed.code : null,
                stdout_bytes: Buffer.byteLength(failed.stdout ?? "", "utf8"),
                stderr_bytes: Buffer.byteLength(failed.stderr ?? failed.message, "utf8")
            }
        });
        return undefined;
    }
}
function extractStructuredOutputFromText(value) {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
    for (const block of fenced.reverse()) {
        const body = block.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = tryParseJsonObject(body);
        if (parsed)
            return parsed;
    }
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse();
    for (const line of lines) {
        const direct = tryParseJsonObject(line);
        if (direct)
            return direct;
        const start = line.indexOf("{");
        const end = line.lastIndexOf("}");
        if (start >= 0 && end > start) {
            const embedded = tryParseJsonObject(line.slice(start, end + 1));
            if (embedded)
                return embedded;
        }
    }
    return extractJsonObject(value);
}
function agentPrompt(node, context) {
    const prompt = stringInput(node, "prompt");
    const outputSchema = recordInput(node, "output_schema") ?? node.verify?.output_schema;
    const contractInstructions = isAgentStepType(node.type)
        ? `\n\n${buildAgentOutputInstructions(node.type, outputSchema)}`
        : "";
    const contextBlock = Object.keys(context.inputs).length > 0
        ? `\n\nDynamic Workflow context JSON:\n${JSON.stringify(context.inputs, null, 2)}`
        : "";
    return [
        `Dynamic Workflow step: ${node.step_id}`,
        `Step type: ${node.type}`,
        prompt ?? "Execute this workflow step according to the available repository context.",
        contractInstructions,
        contextBlock
    ]
        .filter((part) => part.length > 0)
        .join("\n\n");
}
function buildCurrentAgentOutput(node, context, summary) {
    const common = {
        status: "succeeded",
        step_id: node.step_id,
        type: node.type,
        summary,
        context: context.inputs,
        context_sources: context.sources.map((source) => ({ ...source }))
    };
    const contractOutput = isAgentStepType(node.type) ? defaultContractOutput(node, node.type, summary) : {};
    return {
        ...common,
        ...contractOutput,
        ...(recordInput(node, "output") ?? recordInput(node, "structured_output") ?? {})
    };
}
function defaultContractOutput(node, type, summary) {
    const metadata = { contract: type, generated_by: "current_stub" };
    switch (type) {
        case "agent.classify":
            return {
                label: stringInput(node, "label") ?? "unclassified",
                confidence: numberInput(node, "confidence") ?? 1,
                rationale: "Default current-backend classification.",
                metadata
            };
        case "agent.execute":
            return {
                artifacts: [],
                metadata
            };
        case "agent.review":
            return {
                ok: true,
                findings: [],
                blocking_count: 0,
                metadata
            };
        case "agent.synthesize":
            return {
                summary,
                decisions: [],
                next_actions: [],
                metadata
            };
        case "agent.generate":
            return {
                candidates: [{ id: `${node.step_id}_candidate`, summary: `Candidate generated by ${node.step_id}.` }],
                metadata
            };
        case "agent.filter":
            return {
                accepted: stringArrayInput(node, "accepted"),
                rejected: stringArrayInput(node, "rejected"),
                rationale: "Default current-backend filter result.",
                metadata
            };
        case "agent.judge_pair": {
            const winner = stringInput(node, "candidate_a") ?? "candidate_a";
            const loser = stringInput(node, "candidate_b") ?? "candidate_b";
            return {
                winner,
                loser,
                rationale: `${winner} selected over ${loser} by current-backend default judge.`,
                metadata
            };
        }
    }
}
function stringInput(node, key) {
    const value = node.input[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numberInput(node, key) {
    const value = node.input[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function stringArrayInput(node, key) {
    const value = node.input[key];
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
function recordInput(node, key) {
    const value = node.input[key];
    return isRecord(value) ? value : undefined;
}
function parsePaseoRunOutput(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        throw new Error("Paseo stdout was empty.");
    const parsed = tryParseJsonObject(trimmed) ?? extractJsonObject(trimmed);
    if (!parsed) {
        throw new Error("No JSON object found in Paseo stdout.");
    }
    const output = {};
    if (typeof parsed.agentId === "string")
        output.agentId = parsed.agentId;
    if (typeof parsed.status === "string")
        output.status = parsed.status;
    if (typeof parsed.provider === "string")
        output.provider = parsed.provider;
    if (typeof parsed.cwd === "string")
        output.cwd = parsed.cwd;
    if (typeof parsed.title === "string")
        output.title = parsed.title;
    const structuredOutput = extractStructuredOutput(parsed);
    if (structuredOutput) {
        output.structuredOutput = structuredOutput;
    }
    return output;
}
function tryParseJsonObject(value) {
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function extractJsonObject(value) {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        const parsed = tryParseJsonObject(fenced[1].trim());
        if (parsed)
            return parsed;
    }
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse();
    for (const line of lines) {
        const parsed = tryParseJsonObject(line);
        if (parsed)
            return parsed;
    }
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return tryParseJsonObject(value.slice(start, end + 1));
    }
    return undefined;
}
function extractStructuredOutput(parsed) {
    for (const key of ["output", "structured_output", "artifact_output"]) {
        const value = parsed[key];
        if (isRecord(value))
            return value;
    }
    for (const key of ["final_output", "finalMessage", "message", "content", "response", "stdout"]) {
        const value = parsed[key];
        if (typeof value === "string") {
            const embedded = extractJsonObject(value);
            if (embedded)
                return embedded;
        }
    }
    if (hasStableAgentField(parsed)) {
        const structured = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (["agentId", "status", "provider", "cwd", "title"].includes(key))
                continue;
            structured[key] = value;
        }
        return structured;
    }
    if (!("agentId" in parsed) && !("status" in parsed)) {
        return parsed;
    }
    return undefined;
}
function hasStableAgentField(value) {
    return [
        "label",
        "confidence",
        "ok",
        "findings",
        "blocking_count",
        "summary",
        "decisions",
        "next_actions",
        "candidates",
        "accepted",
        "rejected",
        "winner",
        "loser",
        "rationale",
        "artifacts"
    ].some((key) => key in value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assignJsonOptional(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}
function paseoTimeoutMs(value) {
    const match = value.match(/^(\d+)(ms|s|m|h)?$/);
    if (!match)
        return 30 * 60_000;
    const amount = Number(match[1]);
    const unit = match[2] ?? "ms";
    switch (unit) {
        case "h":
            return amount * 60 * 60_000;
        case "m":
            return amount * 60_000;
        case "s":
            return amount * 1000;
        default:
            return amount;
    }
}
async function executeCommands(node, context) {
    const mode = node.type === "command.collect" ? "collect" : "verify";
    const commands = getCommands(node);
    const cwd = commandCwd(node);
    if (commands.length === 0) {
        return {
            status: "failed",
            summary: `${mode === "verify" ? "Verification" : "Collection"} step did not declare any commands.`,
            output: { status: "failed", step_id: node.step_id, checks: [], reason: `missing_${mode}_commands` },
            verify: { ok: false, checks: [] }
        };
    }
    const checks = [];
    const gaps = [];
    for (const [index, declaration] of commands.entries()) {
        const command = normalizeCommand(declaration, index, node);
        const result = await runShell(command, cwd ? { index, context, cwd } : { index, context });
        checks.push(result);
        if (!result.acceptable || result.soft_failed) {
            gaps.push(commandGap(result));
        }
        if (mode === "verify" && !result.acceptable) {
            return {
                status: "failed",
                summary: `Verification command failed: ${command.run}`,
                output: { status: "failed", step_id: node.step_id, checks },
                verify: { ok: false, checks }
            };
        }
        if (mode === "collect" && !result.acceptable && !result.soft_failed) {
            return {
                status: "failed",
                summary: `Collection command failed: ${command.run}`,
                output: { status: "failed", step_id: node.step_id, collection: { ok: false, checks, gaps }, checks },
                verify: { ok: false, checks }
            };
        }
    }
    if (mode === "collect") {
        return {
            status: "succeeded",
            summary: gaps.length > 0 ? `Collection completed with ${gaps.length} gap(s).` : "Collection commands completed.",
            output: { status: "succeeded", step_id: node.step_id, collection: { ok: true, checks, gaps }, checks },
            verify: { ok: true, checks: [] }
        };
    }
    return {
        status: "succeeded",
        summary: "Verification commands passed.",
        output: { status: "succeeded", step_id: node.step_id, checks },
        verify: { ok: true, checks }
    };
}
function getCommands(node) {
    if (node.type === "command.collect") {
        if (Array.isArray(node.collect?.commands)) {
            return node.collect.commands;
        }
        return legacyInputCommands(node);
    }
    if (Array.isArray(node.verify?.commands)) {
        return node.verify.commands;
    }
    return legacyInputCommands(node);
}
function legacyInputCommands(node) {
    if (!Array.isArray(node.input.commands))
        return [];
    return node.input.commands.filter(isCommandDeclaration);
}
function isCommandDeclaration(value) {
    if (typeof value === "string")
        return true;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    return typeof value.run === "string";
}
function normalizeCommand(declaration, index, node) {
    if (typeof declaration === "string") {
        return {
            id: String(index),
            run: declaration,
            allowExitCodes: [0],
            softFail: false,
            timeoutMs: commandTimeoutMs(node),
            stdoutMaxBytes: DEFAULT_OUTPUT_CAP_BYTES,
            stderrMaxBytes: DEFAULT_OUTPUT_CAP_BYTES
        };
    }
    return {
        id: declaration.id ?? String(index),
        run: declaration.run,
        allowExitCodes: declaration.allow_exit_codes ?? [0],
        softFail: declaration.soft_fail ?? false,
        timeoutMs: declaration.timeout_seconds ? Math.round(declaration.timeout_seconds * 1000) : commandTimeoutMs(node),
        stdoutMaxBytes: declaration.stdout_max_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
        stderrMaxBytes: declaration.stderr_max_bytes ?? DEFAULT_OUTPUT_CAP_BYTES
    };
}
async function runShell(command, options) {
    const start = Date.now();
    await options.context.trace?.({
        event: "command_started",
        data: {
            command_index: options.index,
            command_id: command.id,
            command_preview: commandPreview(command.run),
            cwd: options.cwd ?? "",
            timeout_seconds: command.timeoutMs / 1000
        }
    });
    try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", command.run], {
            cwd: options.cwd,
            timeout: command.timeoutMs
        });
        const result = buildShellResult({
            command,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            elapsedMs: Date.now() - start
        });
        await traceCommandFinished(options.context, options.index, result);
        return result;
    }
    catch (error) {
        const failed = error;
        const timedOut = failed.killed === true && failed.signal === "SIGTERM";
        const result = buildShellResult({
            command,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? failed.message,
            exitCode: typeof failed.code === "number" ? failed.code : null,
            signal: typeof failed.signal === "string" ? failed.signal : null,
            timedOut,
            elapsedMs: Date.now() - start
        });
        await traceCommandFinished(options.context, options.index, result);
        if (!result.acceptable) {
            await options.context.trace?.({
                event: "command_failed",
                data: commandTraceData(options.index, result)
            });
        }
        return result;
    }
}
function buildShellResult(params) {
    const stdout = clipTail(params.stdout, params.command.stdoutMaxBytes);
    const stderr = clipTail(params.stderr, params.command.stderrMaxBytes);
    const acceptable = params.exitCode !== null && params.command.allowExitCodes.includes(params.exitCode) && !params.timedOut;
    const result = {
        id: params.command.id,
        command: params.command.run,
        exit_code: params.exitCode,
        signal: params.signal,
        timed_out: params.timedOut,
        elapsed_ms: params.elapsedMs,
        stdout: stdout.value,
        stderr: stderr.value,
        stdout_bytes: Buffer.byteLength(params.stdout, "utf8"),
        stderr_bytes: Buffer.byteLength(params.stderr, "utf8"),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        acceptable,
        soft_failed: !acceptable && params.command.softFail
    };
    if (!acceptable) {
        result.failure_category = classifyFailure(result);
        result.repair_hint = repairHint(result.failure_category);
    }
    return result;
}
function commandGap(result) {
    return {
        id: result.id,
        command: result.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        failure_category: result.failure_category ?? "runtime_error",
        repair_hint: result.repair_hint ?? repairHint("runtime_error"),
        soft_failed: result.soft_failed
    };
}
function clipTail(value, maxBytes) {
    const originalBytes = Buffer.byteLength(value, "utf8");
    if (originalBytes <= maxBytes) {
        return { value, truncated: false };
    }
    let result = "";
    let usedBytes = 0;
    for (const char of [...value].reverse()) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (usedBytes + charBytes > maxBytes)
            break;
        result = char + result;
        usedBytes += charBytes;
    }
    return { value: result, truncated: true };
}
function classifyFailure(result) {
    const stderr = result.stderr.toLowerCase();
    const command = result.command.trim();
    if (result.timed_out)
        return "timeout";
    if (stderr.includes("no such file or directory") || stderr.includes("not a directory"))
        return "missing_path";
    if (command.includes("rg ") &&
        result.exit_code === 1 &&
        !stderr.includes("no such file or directory") &&
        !stderr.includes("not a directory") &&
        !stderr.includes("error") &&
        !stderr.includes("permission denied")) {
        return "no_match";
    }
    if (result.signal !== null ||
        result.exit_code === 127 ||
        result.exit_code === 126 ||
        stderr.includes("syntax error") ||
        stderr.includes("command not found") ||
        stderr.includes("permission denied")) {
        return "shell_error";
    }
    return "nonzero_exit";
}
function repairHint(category) {
    switch (category) {
        case "timeout":
            return "Narrow the command scope or set a justified timeout_seconds.";
        case "missing_path":
            return "Check the path or mark the probe optional in a collection step.";
        case "no_match":
            return "Treat the result as empty evidence or broaden the query deliberately.";
        case "shell_error":
            return "Fix quoting, executable path, or permission assumptions.";
        default:
            return "Inspect capped stdout/stderr and fix the failing invariant.";
    }
}
async function traceCommandFinished(context, index, result) {
    await context.trace?.({
        event: "command_finished",
        data: commandTraceData(index, result)
    });
}
function commandTraceData(index, result) {
    const data = {
        command_index: index,
        command_id: result.id,
        command_preview: commandPreview(result.command),
        elapsed_ms: result.elapsed_ms,
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out,
        acceptable: result.acceptable,
        soft_failed: result.soft_failed,
        stdout_bytes: result.stdout_bytes,
        stderr_bytes: result.stderr_bytes
    };
    if (result.failure_category)
        data.failure_category = result.failure_category;
    if (result.repair_hint)
        data.repair_hint = result.repair_hint;
    return data;
}
function commandPreview(command) {
    const compact = command.replace(/\s+/g, " ").trim();
    return compact.length > COMMAND_PREVIEW_LENGTH ? `${compact.slice(0, COMMAND_PREVIEW_LENGTH - 1)}…` : compact;
}
function commandCwd(node) {
    const cwd = stringInput(node, "cwd");
    if (cwd)
        return cwd;
    const resourceScope = stringInput(node, "resource_scope");
    return resourceScope?.startsWith("/") ? resourceScope : undefined;
}
function commandTimeoutMs(node) {
    const timeoutSeconds = node.input.timeout_seconds;
    if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
        return Math.round(timeoutSeconds * 1000);
    }
    return DEFAULT_COMMAND_TIMEOUT_MS;
}
//# sourceMappingURL=current.js.map