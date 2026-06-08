import { access } from "node:fs/promises";
import path from "node:path";

import type { CompiledManifest } from "./compiler.js";
import type { StepRuntimeState } from "./scheduler.js";
import type { JsonObject, WorkflowState } from "./types.js";

export interface AuditResult {
  ok: boolean;
  findings: JsonObject[];
}

export async function auditRun(params: {
  runDir: string;
  workflowState: WorkflowState;
  manifest: CompiledManifest;
  steps: Record<string, StepRuntimeState>;
}): Promise<AuditResult> {
  const findings: JsonObject[] = [];
  const requiredFiles = ["plan.yaml", "compiled_manifest.json", "trace.jsonl"];
  for (const file of requiredFiles) {
    const filePath = path.join(params.runDir, file);
    await access(filePath).catch(() => {
      findings.push({ code: "missing_run_file", file });
    });
  }
  for (const node of params.manifest.nodes) {
    const state = params.steps[node.step_id];
    if (!state) {
      findings.push({ code: "missing_step_state", step_id: node.step_id });
      continue;
    }
    if (state.state !== "succeeded" && state.state !== "skipped") {
      findings.push({ code: "non_terminal_success_step", step_id: node.step_id, state: state.state });
    }
    if (state.state === "succeeded" && state.output_path) {
      await access(state.output_path).catch(() => {
        findings.push({ code: "missing_step_artifact", step_id: node.step_id });
      });
    } else if (state.state === "succeeded" && !state.output_path) {
      findings.push({ code: "missing_step_artifact", step_id: node.step_id });
    }
  }
  if (params.workflowState !== "completed") {
    findings.push({ code: "workflow_not_completed", state: params.workflowState });
  }
  if (Object.keys(params.manifest.writer_conflicts).length > 0) {
    findings.push({ code: "writer_conflict_present", conflicts: params.manifest.writer_conflicts });
  }
  return { ok: findings.length === 0, findings };
}
