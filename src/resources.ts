import { getStepDefinition } from "./registry.js";
import type { WorkflowStep } from "./types.js";

export interface ResourceLock {
  step_id: string;
  scope: string;
  mode: "read" | "write";
}

export function computeResourceLocks(steps: WorkflowStep[], defaultScope = "workspace"): ResourceLock[] {
  const locks: ResourceLock[] = [];
  for (const step of steps) {
    const definition = getStepDefinition(step.type);
    const scopeValue = step.input?.resource_scope;
    const scope = typeof scopeValue === "string" && scopeValue.trim() !== "" ? scopeValue : defaultScope;
    if (definition.mayWrite) {
      locks.push({ step_id: step.step_id, scope, mode: "write" });
    } else {
      locks.push({ step_id: step.step_id, scope, mode: "read" });
    }
  }
  return locks;
}

export function writerConflicts(
  locks: ResourceLock[],
  dependencies: Record<string, string[]> = {}
): Record<string, string[]> {
  const writersByScope = new Map<string, string[]>();
  for (const lock of locks) {
    if (lock.mode !== "write") continue;
    writersByScope.set(lock.scope, [...(writersByScope.get(lock.scope) ?? []), lock.step_id]);
  }
  const conflicts: Record<string, string[]> = {};
  for (const [scope, writers] of writersByScope.entries()) {
    const concurrent = writers.filter((writer, index) =>
      writers.some((other, otherIndex) => otherIndex !== index && !hasDependencyPath(writer, other, dependencies) && !hasDependencyPath(other, writer, dependencies))
    );
    if (concurrent.length > 1) {
      conflicts[scope] = concurrent;
    }
  }
  return conflicts;
}

function hasDependencyPath(from: string, to: string, dependencies: Record<string, string[]>): boolean {
  const visited = new Set<string>();
  const queue = [...(dependencies[from] ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    if (current === to) return true;
    visited.add(current);
    queue.push(...(dependencies[current] ?? []));
  }
  return false;
}
