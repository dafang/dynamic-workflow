import { SUPPORTED_SCHEMA_VERSION } from "./types.js";
export declare const HOST_LIMITS: {
    readonly max_steps: 200;
    readonly max_subagents: 64;
    readonly max_rounds: 20;
    readonly max_minutes: 480;
    readonly step_max_rounds: 20;
    readonly step_max_minutes: 240;
    readonly step_max_tokens: 1000000;
    readonly context_max_bytes: 1000000;
    readonly context_default_max_bytes: 20000;
};
export declare const SUPPORTED_BACKEND = "current";
export { SUPPORTED_SCHEMA_VERSION };
//# sourceMappingURL=schema.d.ts.map