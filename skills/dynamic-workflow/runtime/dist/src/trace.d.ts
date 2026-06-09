import type { JsonObject } from "./types.js";
export interface TraceEvent {
    event: string;
    run_id: string;
    step_id?: string;
    timestamp: string;
    data?: JsonObject;
}
export declare function appendTrace(tracePath: string, event: Omit<TraceEvent, "timestamp">): Promise<TraceEvent>;
export declare function readTrace(tracePath: string): Promise<TraceEvent[]>;
//# sourceMappingURL=trace.d.ts.map