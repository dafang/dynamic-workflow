import { compilePlan, type CompiledManifest } from "./compiler.js";
import type { WorkflowPlan, WorkflowStep } from "./types.js";

export const HARNESS_ALLOWED_PRIMITIVES = [
  "agent",
  "parallel",
  "pipeline",
  "loop",
  "judge",
  "artifact.read",
  "artifact.write",
  "askUser"
] as const;

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
] as const;

const DENIED_RULES: Array<{ capability: string; pattern: RegExp }> = [
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

export interface HarnessCompileResult {
  plan: WorkflowPlan;
  manifest: CompiledManifest;
}

export function compileHarnessToPlan(source: string, workflowId = "dwf_harness"): HarnessCompileResult {
  assertHarnessSourceAllowed(source);
  const steps = captureHarnessSteps(source);
  const plan: WorkflowPlan = {
    schema_version: "dynamic_workflow/run/v1",
    workflow_id: workflowId,
    kind: "mixed",
    steps
  };
  return { plan, manifest: compilePlan(plan) };
}

export function assertHarnessSourceAllowed(source: string): void {
  const code = stripStringsAndComments(source);
  for (const rule of DENIED_RULES) {
    if (rule.pattern.test(code)) {
      throw new Error(`Harness denied capability: ${rule.capability}`);
    }
  }
}

function stripStringsAndComments(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
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

function captureHarnessSteps(source: string): WorkflowStep[] {
  const captureSource = stripComments(source);
  const steps: WorkflowStep[] = [];
  const seenStepIds = new Map<string, number>();
  let terminalStepIds: string[] = [];
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
    const stepId = uniqueStepId(
      agent.stepId ?? (agent.role === "synthesizer" ? "synthesize" : `agent_${steps.length + 1}`),
      seenStepIds
    );
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

function stripComments(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      output += " ";
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
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
        if (char === quote) break;
      }
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

interface ParsedAgent {
  prompt: string;
  role?: string;
  stepId?: string;
  type: WorkflowStep["type"];
  permissionProfile: NonNullable<WorkflowStep["permission_profile"]>;
}

function parseAgentCalls(source: string): ParsedAgent[] {
  const calls: ParsedAgent[] = [];
  const agentPattern = /agent\s*\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/gm;
  for (const match of source.matchAll(agentPattern)) {
    const prompt = match[1] ?? "Agent step";
    const options = match[2] ?? "";
    const role = readOptionString(options, "role");
    const stepId = readOptionString(options, "step_id");
    const type = role === "synthesizer" ? "agent.synthesize" : role === "reviewer" ? "agent.review" : "agent.execute";
    const permissionProfile =
      type === "agent.synthesize" ? "synthesizer" : type === "agent.review" ? "reviewer_readonly" : "executor_writer";
    const parsed: ParsedAgent = { prompt, type, permissionProfile };
    assignOptional(parsed, "role", role);
    assignOptional(parsed, "stepId", stepId);
    calls.push(parsed);
  }
  return calls;
}

function readOptionString(options: string, key: string): string | undefined {
  const pattern = new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`);
  return options.match(pattern)?.[1];
}

function uniqueStepId(stepId: string, seen: Map<string, number>): string {
  const count = seen.get(stepId) ?? 0;
  seen.set(stepId, count + 1);
  return count === 0 ? stepId : `${stepId}_${count + 1}`;
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
