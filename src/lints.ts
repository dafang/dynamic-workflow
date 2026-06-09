import type { CommandDeclaration, WorkflowPlan, WorkflowStep } from "./types.js";

export interface PlanWarning {
  code: string;
  message: string;
  step_id?: string;
  path?: string;
}

const BROAD_RG_EXCLUDES = [".venv", ".dynamic-workflow", "__pycache__"];

export function lintPlan(plan: WorkflowPlan): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.type !== "command.verify" && step.type !== "command.collect") continue;
    const commands = commandDeclarations(step);
    warnBroadRg(commands, step, stepIndex, warnings);
    warnNestedShell(commands, step, stepIndex, warnings);
    warnVerifyOptionalSearches(commands, step, stepIndex, warnings);
    warnOversizedCommandGroup(commands, step, stepIndex, warnings);
  }
  return warnings;
}

function warnBroadRg(
  commands: CommandDeclaration[],
  step: WorkflowStep,
  stepIndex: number,
  warnings: PlanWarning[]
): void {
  for (const [commandIndex, command] of commands.entries()) {
    const run = commandRun(command);
    if (!/\brg\b/.test(run) || !/--glob\s+['"]?\*\.py['"]?/.test(run)) continue;
    const missing = BROAD_RG_EXCLUDES.filter((exclude) => !run.includes(exclude));
    if (missing.length === 0) continue;
    warnings.push({
      code: "broad_rg_missing_excludes",
      message: `Command scans Python files without excluding ${missing.join(", ")}; add bounded --glob excludes.`,
      step_id: step.step_id,
      path: `steps[${stepIndex}].${commandPath(step)}.commands[${commandIndex}]`
    });
  }
}

function warnNestedShell(
  commands: CommandDeclaration[],
  step: WorkflowStep,
  stepIndex: number,
  warnings: PlanWarning[]
): void {
  for (const [commandIndex, command] of commands.entries()) {
    const run = commandRun(command).trim();
    if (!/^(?:\/bin\/)?sh\s+-c\b/.test(run)) continue;
    warnings.push({
      code: "nested_shell",
      message: "Command wraps another shell with sh -c, but dynamic-workflow already executes through a shell boundary.",
      step_id: step.step_id,
      path: `steps[${stepIndex}].${commandPath(step)}.commands[${commandIndex}]`
    });
  }
}

function warnVerifyOptionalSearches(
  commands: CommandDeclaration[],
  step: WorkflowStep,
  stepIndex: number,
  warnings: PlanWarning[]
): void {
  if (step.type !== "command.verify") return;
  const optionalSearches = commands.filter((command) => looksLikeOptionalSearch(commandRun(command)));
  if (optionalSearches.length < 2) return;
  warnings.push({
    code: "verify_optional_searches",
    message: "command.verify contains multiple search/listing probes that look optional; use command.collect for evidence gathering.",
    step_id: step.step_id,
    path: `steps[${stepIndex}].verify.commands`
  });
}

function warnOversizedCommandGroup(
  commands: CommandDeclaration[],
  step: WorkflowStep,
  stepIndex: number,
  warnings: PlanWarning[]
): void {
  if (commands.length < 6) return;
  warnings.push({
    code: "oversized_command_group",
    message: `Command step has ${commands.length} commands; split evidence collection and final verification into separate steps.`,
    step_id: step.step_id,
    path: `steps[${stepIndex}].${commandPath(step)}.commands`
  });
}

function commandDeclarations(step: WorkflowStep): CommandDeclaration[] {
  if (step.type === "command.collect") {
    return step.collect?.commands ?? inputCommands(step);
  }
  return step.verify?.commands ?? inputCommands(step);
}

function inputCommands(step: WorkflowStep): CommandDeclaration[] {
  const commands = step.input?.commands;
  if (!Array.isArray(commands)) return [];
  return (commands as unknown[]).filter(isCommandDeclaration);
}

function isCommandDeclaration(value: unknown): value is CommandDeclaration {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as { run?: unknown }).run === "string";
}

function commandRun(command: CommandDeclaration): string {
  return typeof command === "string" ? command : command.run;
}

function commandPath(step: WorkflowStep): "verify" | "collect" | "input" {
  if (step.type === "command.collect" && step.collect?.commands) return "collect";
  if (step.type === "command.verify" && step.verify?.commands) return "verify";
  return "input";
}

function looksLikeOptionalSearch(command: string): boolean {
  return /\b(rg|grep|find|ls)\b/.test(command) && !/\b(npm|node|tsc|vitest|jest|pytest|cargo|go test)\b/.test(command);
}
