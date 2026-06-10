import type { JsonObject, JsonValue, StepType } from "./types.js";
export type AgentStepType = "agent.classify" | "agent.execute" | "agent.review" | "agent.synthesize" | "agent.generate" | "agent.filter" | "agent.judge_pair";
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
export declare const AGENT_STEP_TYPES: readonly AgentStepType[];
export declare const SUPPORTED_JSON_SCHEMA_KEYWORDS: readonly ["type", "object", "array", "string", "number", "integer", "boolean", "enum", "required", "properties", "items", "additionalProperties"];
export declare const AGENT_OUTPUT_CONTRACTS: Readonly<Record<AgentStepType, AgentOutputContract>>;
export declare function isAgentStepType(type: StepType): type is AgentStepType;
export declare function getAgentOutputContract(type: AgentStepType): AgentOutputContract;
export declare function agentContractSchemaAsJson(type: AgentStepType): JsonObject;
export declare function buildAgentOutputInstructions(type: AgentStepType, extraSchema?: JsonObject): string;
export declare function validateAgentOutput(type: AgentStepType, output: JsonObject, extraSchemas?: readonly JsonObject[]): SchemaValidationResult;
export declare function validateJsonSchema(value: JsonValue, schema: JsonSchemaSubset, path?: string): SchemaValidationResult;
//# sourceMappingURL=agent-contracts.d.ts.map