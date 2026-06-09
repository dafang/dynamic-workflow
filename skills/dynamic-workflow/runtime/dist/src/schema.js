import { SUPPORTED_SCHEMA_VERSION } from "./types.js";
export const HOST_LIMITS = {
    max_steps: 200,
    max_subagents: 64,
    max_rounds: 20,
    max_minutes: 480,
    step_max_rounds: 20,
    step_max_minutes: 240,
    step_max_tokens: 1_000_000,
    context_max_bytes: 1_000_000,
    context_default_max_bytes: 20_000
};
export const SUPPORTED_BACKEND = "current";
export { SUPPORTED_SCHEMA_VERSION };
//# sourceMappingURL=schema.js.map