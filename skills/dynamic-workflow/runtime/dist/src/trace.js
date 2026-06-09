import { appendFile, readFile } from "node:fs/promises";
export async function appendTrace(tracePath, event) {
    const fullEvent = {
        ...event,
        timestamp: new Date().toISOString()
    };
    await appendFile(tracePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
    return fullEvent;
}
export async function readTrace(tracePath) {
    const text = await readFile(tracePath, "utf8").catch((error) => {
        if (error.code === "ENOENT")
            return "";
        throw error;
    });
    return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
//# sourceMappingURL=trace.js.map