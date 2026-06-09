import { readJson } from "./artifacts.js";
import type { CompiledNode } from "./compiler.js";
import { HOST_LIMITS } from "./schema.js";
import type { StepRuntimeState } from "./scheduler.js";
import type { StepContext, StepContextSource } from "./backend.js";
import type { JsonObject, JsonValue, StepConsume } from "./types.js";

interface BuildContextParams {
  runId: string;
  node: CompiledNode;
  steps: Record<string, StepRuntimeState>;
}

export async function buildStepContext(params: BuildContextParams): Promise<StepContext> {
  const inputs: JsonObject = {};
  const sources: StepContextSource[] = [];
  for (const consume of params.node.consumes ?? []) {
    const dependency = params.steps[consume.from];
    if (!dependency?.output_path) {
      if (consume.required === false) {
        sources.push(emptySource(consume, "", "missing_step_artifact"));
        continue;
      }
      throw new Error(`Required context ${consume.as} from ${consume.from} is missing its step artifact.`);
    }
    const artifact = await readJson<JsonValue>(dependency.output_path);
    const selected = selectArtifactValue(artifact, consume.select);
    if (selected === undefined) {
      if (consume.required === false) {
        sources.push(emptySource(consume, dependency.output_path, "missing_selector"));
        continue;
      }
      throw new Error(`Required context ${consume.as} from ${consume.from} selector ${consume.select} was not found.`);
    }
    const clipped = clipContextValue(selected, consume.max_bytes ?? HOST_LIMITS.context_default_max_bytes);
    inputs[consume.as] = clipped.value;
    sources.push({
      alias: consume.as,
      from_step: consume.from,
      output_path: dependency.output_path,
      selected_path: consume.select,
      required: consume.required !== false,
      clipped: clipped.clipped,
      original_bytes: clipped.originalBytes,
      selected_bytes: clipped.selectedBytes
    });
  }
  return { run_id: params.runId, step_id: params.node.step_id, inputs, sources };
}

export function selectArtifactValue(value: JsonValue, selector: string): JsonValue | undefined {
  if (selector === "$") return value;
  if (!selector.startsWith("$.")) return undefined;
  const tokens = selector.slice(2).split(".");
  return selectTokens(value, tokens);
}

function selectTokens(value: JsonValue | undefined, tokens: string[]): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (tokens.length === 0) return value;
  const [head, ...tail] = tokens;
  if (head === undefined) return value;
  const wildcard = head.endsWith("[*]");
  const key = wildcard ? head.slice(0, -3) : head;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const next = value[key];
  if (wildcard) {
    if (!Array.isArray(next)) return undefined;
    const selected = next
      .map((item) => selectTokens(item, tail))
      .filter((item): item is JsonValue => item !== undefined);
    return selected.length === 0 ? undefined : selected;
  }
  return selectTokens(next, tail);
}

function clipContextValue(value: JsonValue, maxBytes: number): { value: JsonValue; clipped: boolean; originalBytes: number; selectedBytes: number } {
  const serialized = JSON.stringify(value);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) {
    return { value, clipped: false, originalBytes, selectedBytes: originalBytes };
  }
  const clippedText = clipUtf8Prefix(serialized, maxBytes);
  return {
    value: clippedText,
    clipped: true,
    originalBytes,
    selectedBytes: Buffer.byteLength(clippedText, "utf8")
  };
}

function clipUtf8Prefix(value: string, maxBytes: number): string {
  let usedBytes = 0;
  let result = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) break;
    result += char;
    usedBytes += charBytes;
  }
  return result;
}

function emptySource(consume: StepConsume, outputPath: string, reason: string): StepContextSource {
  return {
    alias: consume.as,
    from_step: consume.from,
    output_path: outputPath,
    selected_path: `${consume.select} (${reason})`,
    required: false,
    clipped: false,
    original_bytes: 0,
    selected_bytes: 0
  };
}
