import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Backend, BackendStepResult, StepContext } from "../backend.js";
import type { CompiledNode } from "../compiler.js";
import type { CommandDeclaration, JsonObject } from "../types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_CAP_BYTES = 2_000;
const COMMAND_PREVIEW_LENGTH = 160;

export class CurrentBackend implements Backend {
  readonly name = "current" as const;

  async executeStep(node: CompiledNode, context: StepContext): Promise<BackendStepResult> {
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
    return {
      status: "succeeded",
      summary: `Executed ${node.step_id} through current host boundary.`,
      output: {
        status: "succeeded",
        step_id: node.step_id,
        type: node.type,
        summary: `Executed ${node.step_id} through current host boundary.`,
        context: context.inputs,
        context_sources: context.sources.map((source) => ({ ...source })),
        artifacts: []
      }
    };
  }
}

interface ShellResult extends JsonObject {
  id: string;
  command: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  elapsed_ms: number;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  acceptable: boolean;
  soft_failed: boolean;
  failure_category?: string;
  repair_hint?: string;
}

interface NormalizedCommand {
  id: string;
  run: string;
  allowExitCodes: number[];
  softFail: boolean;
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
}

async function executeCommands(node: CompiledNode, context: StepContext): Promise<BackendStepResult> {
  const mode = node.type === "command.collect" ? "collect" : "verify";
  const commands = getCommands(node);
  if (commands.length === 0) {
    return {
      status: "failed",
      summary: `${mode === "verify" ? "Verification" : "Collection"} step did not declare any commands.`,
      output: { status: "failed", step_id: node.step_id, checks: [], reason: `missing_${mode}_commands` },
      verify: { ok: false, checks: [] }
    };
  }
  const checks: JsonObject[] = [];
  const gaps: JsonObject[] = [];
  for (const [index, declaration] of commands.entries()) {
    const command = normalizeCommand(declaration, index, node);
    const result = await runShell(command, { index, context });
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

function getCommands(node: CompiledNode): CommandDeclaration[] {
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

function legacyInputCommands(node: CompiledNode): CommandDeclaration[] {
  if (!Array.isArray(node.input.commands)) return [];
  return (node.input.commands as unknown[]).filter(isCommandDeclaration);
}

function isCommandDeclaration(value: unknown): value is CommandDeclaration {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as { run?: unknown }).run === "string";
}

function normalizeCommand(
  declaration: CommandDeclaration,
  index: number,
  node: CompiledNode
): NormalizedCommand {
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

async function runShell(
  command: NormalizedCommand,
  options: { index: number; context: StepContext }
): Promise<ShellResult> {
  const start = Date.now();
  await options.context.trace?.({
    event: "command_started",
    data: {
      command_index: options.index,
      command_id: command.id,
      command_preview: commandPreview(command.run),
      timeout_seconds: command.timeoutMs / 1000
    }
  });
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command.run], { timeout: command.timeoutMs });
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
  } catch (error) {
    const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
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

function buildShellResult(params: {
  command: NormalizedCommand;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  elapsedMs: number;
}): ShellResult {
  const stdout = clipTail(params.stdout, params.command.stdoutMaxBytes);
  const stderr = clipTail(params.stderr, params.command.stderrMaxBytes);
  const acceptable =
    params.exitCode !== null && params.command.allowExitCodes.includes(params.exitCode) && !params.timedOut;
  const result: ShellResult = {
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

function commandGap(result: ShellResult): JsonObject {
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

function clipTail(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) {
    return { value, truncated: false };
  }
  let result = "";
  let usedBytes = 0;
  for (const char of [...value].reverse()) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) break;
    result = char + result;
    usedBytes += charBytes;
  }
  return { value: result, truncated: true };
}

function classifyFailure(result: ShellResult): string {
  const stderr = result.stderr.toLowerCase();
  const command = result.command.trim();
  if (result.timed_out) return "timeout";
  if (stderr.includes("no such file or directory") || stderr.includes("not a directory")) return "missing_path";
  if (
    command.includes("rg ") &&
    result.exit_code === 1 &&
    !stderr.includes("no such file or directory") &&
    !stderr.includes("not a directory") &&
    !stderr.includes("error") &&
    !stderr.includes("permission denied")
  ) {
    return "no_match";
  }
  if (
    result.signal !== null ||
    result.exit_code === 127 ||
    result.exit_code === 126 ||
    stderr.includes("syntax error") ||
    stderr.includes("command not found") ||
    stderr.includes("permission denied")
  ) {
    return "shell_error";
  }
  return "nonzero_exit";
}

function repairHint(category: string): string {
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

async function traceCommandFinished(context: StepContext, index: number, result: ShellResult): Promise<void> {
  await context.trace?.({
    event: "command_finished",
    data: commandTraceData(index, result)
  });
}

function commandTraceData(index: number, result: ShellResult): JsonObject {
  const data: JsonObject = {
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
  if (result.failure_category) data.failure_category = result.failure_category;
  if (result.repair_hint) data.repair_hint = result.repair_hint;
  return data;
}

function commandPreview(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > COMMAND_PREVIEW_LENGTH ? `${compact.slice(0, COMMAND_PREVIEW_LENGTH - 1)}…` : compact;
}

function commandTimeoutMs(node: CompiledNode): number {
  const timeoutSeconds = node.input.timeout_seconds;
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.round(timeoutSeconds * 1000);
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}
