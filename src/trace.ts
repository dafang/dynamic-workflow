import { appendFile, readFile } from "node:fs/promises";

import type { JsonObject } from "./types.js";

export interface TraceEvent {
  event: string;
  run_id: string;
  step_id?: string;
  timestamp: string;
  data?: JsonObject;
}

export async function appendTrace(tracePath: string, event: Omit<TraceEvent, "timestamp">): Promise<TraceEvent> {
  const fullEvent: TraceEvent = {
    ...event,
    timestamp: new Date().toISOString()
  };
  await appendFile(tracePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
  return fullEvent;
}

export async function readTrace(tracePath: string): Promise<TraceEvent[]> {
  const text = await readFile(tracePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}
