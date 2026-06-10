import type { JsonObject, JsonValue, StepType } from "./types.js";

export type AgentStepType =
  | "agent.classify"
  | "agent.execute"
  | "agent.review"
  | "agent.synthesize"
  | "agent.generate"
  | "agent.filter"
  | "agent.judge_pair";

export type JsonSchemaPrimitiveType = "object" | "array" | "string" | "number" | "integer" | "boolean";

export interface JsonSchemaSubset {
  readonly type?: JsonSchemaPrimitiveType;
  readonly enum?: readonly (string | number | boolean)[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaSubset>>;
  readonly items?: JsonSchemaSubset;
  readonly additionalProperties?: boolean | JsonSchemaSubset;
  readonly description?: string;
}

export interface AgentOutputContract {
  readonly type: AgentStepType;
  readonly description: string;
  readonly stableFields: readonly string[];
  readonly schema: JsonSchemaSubset;
  readonly instructions: readonly string[];
}

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly errors: readonly SchemaValidationError[];
}

export const AGENT_STEP_TYPES: readonly AgentStepType[] = [
  "agent.classify",
  "agent.execute",
  "agent.review",
  "agent.synthesize",
  "agent.generate",
  "agent.filter",
  "agent.judge_pair"
] as const;

export const SUPPORTED_JSON_SCHEMA_KEYWORDS = [
  "type",
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "enum",
  "required",
  "properties",
  "items",
  "additionalProperties"
] as const;

const metadataSchema: JsonSchemaSubset = {
  type: "object",
  additionalProperties: true,
  description: "Small bounded metadata object for provenance, confidence notes, or backend ids."
};

const findingSchema: JsonSchemaSubset = {
  type: "object",
  required: ["severity", "message"],
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["info", "warning", "blocking"] },
    message: { type: "string" },
    evidence: { type: "string" }
  }
};

const candidateSchema: JsonSchemaSubset = {
  type: "object",
  required: ["id", "summary"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
    rationale: { type: "string" },
    metadata: metadataSchema
  }
};

const artifactSchema: JsonSchemaSubset = {
  type: "object",
  required: ["path", "kind", "status"],
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    kind: { type: "string", enum: ["file", "command", "result", "note"] },
    status: { type: "string" },
    summary: { type: "string" }
  }
};

export const AGENT_OUTPUT_CONTRACTS: Readonly<Record<AgentStepType, AgentOutputContract>> = {
  "agent.classify": {
    type: "agent.classify",
    description: "Classify the request or evidence into a stable branch label.",
    stableFields: ["label", "confidence", "metadata"],
    schema: {
      type: "object",
      required: ["label", "confidence"],
      additionalProperties: true,
      properties: {
        label: { type: "string" },
        confidence: { type: "number" },
        rationale: { type: "string" },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return a branch label in output.label.",
      "Return a numeric confidence from 0 to 1 in output.confidence.",
      "Use output.metadata only for bounded provenance or classification hints."
    ]
  },
  "agent.execute": {
    type: "agent.execute",
    description: "Execute a focused implementation or filesystem-affecting task and report durable artifacts.",
    stableFields: ["artifacts", "metadata"],
    schema: {
      type: "object",
      required: ["artifacts"],
      additionalProperties: true,
      properties: {
        artifacts: { type: "array", items: artifactSchema },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return every created or modified durable artifact in output.artifacts.",
      "Each artifact must include path, kind, status, and optional summary.",
      "Use output.metadata for bounded backend ids, cwd, or execution provenance."
    ]
  },
  "agent.review": {
    type: "agent.review",
    description: "Review an input, implementation, or plan and report blocking and non-blocking findings.",
    stableFields: ["ok", "findings", "blocking_count", "metadata"],
    schema: {
      type: "object",
      required: ["ok", "findings", "blocking_count"],
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        findings: { type: "array", items: findingSchema },
        blocking_count: { type: "integer" },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return output.ok as true only when no blocking issue remains.",
      "Return output.findings as an array of review findings with severity and message.",
      "Return output.blocking_count as the integer count of blocking findings."
    ]
  },
  "agent.synthesize": {
    type: "agent.synthesize",
    description: "Merge upstream outputs into a concise summary, decisions, and next actions.",
    stableFields: ["summary", "decisions", "next_actions", "metadata"],
    schema: {
      type: "object",
      required: ["summary", "decisions", "next_actions"],
      additionalProperties: true,
      properties: {
        summary: { type: "string" },
        decisions: { type: "array", items: { type: "string" } },
        next_actions: { type: "array", items: { type: "string" } },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return output.summary as the synthesized result.",
      "Return output.decisions as stable decision strings.",
      "Return output.next_actions as concrete follow-up actions."
    ]
  },
  "agent.generate": {
    type: "agent.generate",
    description: "Generate candidate plans, approaches, or artifacts for later filtering or judging.",
    stableFields: ["candidates", "metadata"],
    schema: {
      type: "object",
      required: ["candidates"],
      additionalProperties: true,
      properties: {
        candidates: { type: "array", items: candidateSchema },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return output.candidates as a non-empty array when viable candidates exist.",
      "Each candidate must include id and summary.",
      "Use optional rationale for why the candidate exists."
    ]
  },
  "agent.filter": {
    type: "agent.filter",
    description: "Filter or rank candidate ids against explicit criteria.",
    stableFields: ["accepted", "rejected", "metadata"],
    schema: {
      type: "object",
      required: ["accepted", "rejected"],
      additionalProperties: true,
      properties: {
        accepted: { type: "array", items: { type: "string" } },
        rejected: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return output.accepted as accepted candidate ids.",
      "Return output.rejected as rejected candidate ids.",
      "Use output.rationale for a bounded explanation of the filter decision."
    ]
  },
  "agent.judge_pair": {
    type: "agent.judge_pair",
    description: "Judge two candidates and identify a stable winner and loser.",
    stableFields: ["winner", "loser", "rationale", "metadata"],
    schema: {
      type: "object",
      required: ["winner", "loser", "rationale"],
      additionalProperties: true,
      properties: {
        winner: { type: "string" },
        loser: { type: "string" },
        rationale: { type: "string" },
        metadata: metadataSchema
      }
    },
    instructions: [
      "Return output.winner as the winning candidate id.",
      "Return output.loser as the losing candidate id.",
      "Return output.rationale as the bounded reason for the choice."
    ]
  }
} as const;

export function isAgentStepType(type: StepType): type is AgentStepType {
  return AGENT_STEP_TYPES.includes(type as AgentStepType);
}

export function getAgentOutputContract(type: AgentStepType): AgentOutputContract {
  return AGENT_OUTPUT_CONTRACTS[type];
}

export function agentContractSchemaAsJson(type: AgentStepType): JsonObject {
  return AGENT_OUTPUT_CONTRACTS[type].schema as JsonObject;
}

export function buildAgentOutputInstructions(type: AgentStepType, extraSchema?: JsonObject): string {
  const contract = getAgentOutputContract(type);
  const lines = [
    "Return a single JSON object for Dynamic Workflow.",
    "Do not include prose outside the JSON object.",
    "The JSON object is merged into artifact.output and must satisfy this built-in contract:",
    JSON.stringify(contract.schema, null, 2),
    ...contract.instructions.map((instruction) => `- ${instruction}`)
  ];
  if (extraSchema) {
    lines.push("It must also satisfy this step-specific output schema:", JSON.stringify(extraSchema, null, 2));
  }
  return lines.join("\n");
}

export function validateAgentOutput(
  type: AgentStepType,
  output: JsonObject,
  extraSchemas: readonly JsonObject[] = []
): SchemaValidationResult {
  const schemas: readonly JsonSchemaSubset[] = [
    getAgentOutputContract(type).schema,
    ...extraSchemas.map((schema) => schema as JsonSchemaSubset)
  ];
  const errors = schemas.flatMap((schema) => validateJsonSchema(output, schema).errors).slice(0, 20);
  return { ok: errors.length === 0, errors };
}

export function validateJsonSchema(value: JsonValue, schema: JsonSchemaSubset, path = "$"): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  validateAgainstSchema(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function validateAgainstSchema(
  value: JsonValue,
  schema: JsonSchemaSubset,
  path: string,
  errors: SchemaValidationError[]
): void {
  if (errors.length >= 20) return;
  const expectedType = schema.type ?? inferSchemaType(schema);
  if (expectedType && !matchesType(value, expectedType)) {
    errors.push({ path, message: `Expected ${expectedType}, got ${describeType(value)}.` });
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    errors.push({ path, message: `Value must be one of: ${schema.enum.map(String).join(", ")}.` });
  }
  if (expectedType === "object" || schema.required || schema.properties || schema.additionalProperties !== undefined) {
    validateObject(value, schema, path, errors);
  }
  if ((expectedType === "array" || schema.items) && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateAgainstSchema(item, schema.items as JsonSchemaSubset, `${path}[${index}]`, errors));
  }
}

function validateObject(
  value: JsonValue,
  schema: JsonSchemaSubset,
  path: string,
  errors: SchemaValidationError[]
): void {
  if (!isRecord(value)) {
    errors.push({ path, message: `Expected object, got ${describeType(value)}.` });
    return;
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      errors.push({ path: `${path}.${key}`, message: "Required property is missing." });
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    const nested = value[key];
    if (nested !== undefined) {
      validateAgainstSchema(nested, propertySchema, `${path}.${key}`, errors);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push({ path: `${path}.${key}`, message: "Additional property is not allowed." });
      }
    }
  } else if (typeof schema.additionalProperties === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (!(key in properties)) {
        validateAgainstSchema(nested, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
}

function inferSchemaType(schema: JsonSchemaSubset): JsonSchemaPrimitiveType | undefined {
  if (schema.properties || schema.required || schema.additionalProperties !== undefined) return "object";
  if (schema.items) return "array";
  return undefined;
}

function matchesType(value: JsonValue, type: JsonSchemaPrimitiveType): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function describeType(value: JsonValue): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
