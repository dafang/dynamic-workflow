import path from "node:path";

import { auditRun, type AuditResult } from "./audit.js";
import { createArtifactStore, readJson, writeStepArtifact } from "./artifacts.js";
import type { Backend } from "./backend.js";
import { compilePlan, type CompiledManifest } from "./compiler.js";
import { CurrentBackend } from "./backends/current.js";
import { blockDownstream, getReadyStepIds, initialStepStates } from "./scheduler.js";
import { RunStore, type RunRecord } from "./store.js";
import { appendTrace } from "./trace.js";
import type { JsonObject, JsonValue, RunCondition, WorkflowPlan } from "./types.js";

export interface RunWorkflowOptions {
  rootDir?: string;
  runId?: string;
  backend?: Backend;
  stopAfterStepId?: string;
}

export interface RunWorkflowResult {
  record: RunRecord;
  manifest: CompiledManifest;
  audit: AuditResult;
  markers: string[];
}

export async function runWorkflow(planInput: unknown, options: RunWorkflowOptions = {}): Promise<RunWorkflowResult> {
  const manifest = compilePlan(planInput);
  const plan = manifest.original_plan;
  const runId = options.runId ?? createRunId(plan);
  const store = new RunStore(options.rootDir);
  const steps = initialStepStates(manifest);
  const record = await store.createRun(runId, plan, manifest, steps);
  const tracePath = path.join(record.run_dir, "trace.jsonl");
  const artifactStore = await createArtifactStore(record.run_dir);
  const backend = options.backend ?? new CurrentBackend();
  const markers: string[] = [];

  await appendTrace(tracePath, { event: "workflow_created", run_id: runId, data: { workflow_id: plan.workflow_id } });
  record.state = "running";
  await store.saveRun(record);

  while (record.state === "running") {
    const ready = getReadyStepIds(manifest, record.steps);
    if (ready.length === 0) break;
    for (const stepId of ready) {
      const node = manifest.nodes.find((candidate) => candidate.step_id === stepId);
      const state = record.steps[stepId];
      if (!node || !state) continue;
      if (node.run_if && !(await evaluateRunIf(node.run_if, record))) {
        state.state = "skipped";
        state.summary = `Skipped because run_if was false: ${node.run_if.step}.${node.run_if.output_path}`;
        await appendTrace(tracePath, {
          event: "step_skipped",
          run_id: runId,
          step_id: stepId,
          data: { reason: state.summary }
        });
        await store.saveRun(record);
        continue;
      }
      state.state = "running";
      state.attempts += 1;
      markers.push(`DW_STEP_START ${stepId}`);
      await appendTrace(tracePath, { event: "step_started", run_id: runId, step_id: stepId });

      const result = await backend.executeStep(node);
      state.summary = result.summary;
      const output: JsonObject = {
        step_id: stepId,
        status: result.status,
        summary: result.summary,
        output: result.output,
        verify: result.verify ?? { ok: result.status === "succeeded", checks: [] }
      };
      state.output_path = await writeStepArtifact(artifactStore, stepId, output);
      markers.push(`DW_STEP_VERIFY ${stepId} ${result.status}`);

      if (result.status === "succeeded") {
        state.state = "succeeded";
        await appendTrace(tracePath, { event: "step_succeeded", run_id: runId, step_id: stepId, data: { summary: result.summary } });
        markers.push(`DW_STEP_DONE ${stepId}`);
      } else if (result.status === "waiting_user") {
        state.state = "waiting_user";
        record.state = "waiting_user";
        await appendTrace(tracePath, { event: "step_waiting_user", run_id: runId, step_id: stepId });
      } else {
        state.state = "failed";
        state.failure = result.summary;
        record.state = "failed";
        blockDownstream(manifest, record.steps, stepId);
        await appendTrace(tracePath, { event: "step_failed", run_id: runId, step_id: stepId, data: { summary: result.summary } });
      }
      await store.saveRun(record);
      if (options.stopAfterStepId === stepId || record.state !== "running") break;
    }
  }

  if (record.state === "running") {
    const states = Object.values(record.steps).map((step) => step.state);
    if (states.every((state) => state === "succeeded" || state === "skipped")) {
      record.state = "completed";
      await appendTrace(tracePath, { event: "workflow_completed", run_id: runId });
    } else if (states.some((state) => state === "failed" || state === "blocked")) {
      record.state = "failed";
    } else {
      record.state = "partial_succeeded";
    }
    await store.saveRun(record);
  }

  markers.push("DW_REVIEW_START");
  const audit = await auditRun({ runDir: record.run_dir, workflowState: record.state, manifest, steps: record.steps });
  markers.push(`DW_REVIEW_COMPLETE ${audit.ok ? "ok" : "failed"}`);
  if (audit.ok) {
    markers.push("DW_RUN_COMPLETE");
  }
  await appendTrace(tracePath, { event: "workflow_audited", run_id: runId, data: { ok: audit.ok, findings: audit.findings } });
  return { record, manifest, audit, markers };
}

export function createRunId(plan: WorkflowPlan): string {
  const suffix = Date.now().toString(36);
  return `${plan.workflow_id.replace(/[^A-Za-z0-9_-]/g, "_")}_${suffix}`;
}

async function evaluateRunIf(condition: RunCondition, record: RunRecord): Promise<boolean> {
  const dependency = record.steps[condition.step];
  if (!dependency?.output_path) return false;
  const artifact = await readJson<JsonObject>(dependency.output_path);
  const value = readPath(artifact, ["output", ...condition.output_path.split(".")]);
  switch (condition.op) {
    case "exists":
      return value !== undefined;
    case "not_exists":
      return value === undefined;
    case "==":
      return value === condition.value;
    case "!=":
      return value !== condition.value;
    case ">":
      return typeof value === "number" && typeof condition.value === "number" && value > condition.value;
    case ">=":
      return typeof value === "number" && typeof condition.value === "number" && value >= condition.value;
    case "<":
      return typeof value === "number" && typeof condition.value === "number" && value < condition.value;
    case "<=":
      return typeof value === "number" && typeof condition.value === "number" && value <= condition.value;
  }
}

function readPath(value: JsonValue | undefined, pathParts: string[]): JsonValue | undefined {
  let current = value;
  for (const part of pathParts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}
