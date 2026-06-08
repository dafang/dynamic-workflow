import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JsonObject } from "./types.js";

export interface ArtifactStore {
  root: string;
  stepsDir: string;
  artifactsDir: string;
}

export async function createArtifactStore(runDir: string): Promise<ArtifactStore> {
  const stepsDir = path.join(runDir, "steps");
  const artifactsDir = path.join(runDir, "artifacts");
  await mkdir(stepsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  return { root: runDir, stepsDir, artifactsDir };
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeStepArtifact(store: ArtifactStore, stepId: string, value: JsonObject): Promise<string> {
  const filePath = path.join(store.stepsDir, `${stepId}.json`);
  await writeJson(filePath, sanitizeForUser(value));
  return filePath;
}

export function sanitizeForUser<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForUser(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/secret|token|password|raw_prompt|internal_prompt|debug/i.test(key)) continue;
      clean[key] = sanitizeForUser(nested);
    }
    return clean as T;
  }
  return value;
}
