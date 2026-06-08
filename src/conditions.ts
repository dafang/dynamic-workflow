import type { RunCondition } from "./types.js";

const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateOutputPath(path: string): boolean {
  if (path.trim() === "") return false;
  return path.split(".").every((segment) => PATH_SEGMENT.test(segment));
}

export function describeCondition(condition: RunCondition): string {
  const value = condition.value === undefined ? "" : ` ${JSON.stringify(condition.value)}`;
  return `${condition.step}.${condition.output_path} ${condition.op}${value}`;
}
