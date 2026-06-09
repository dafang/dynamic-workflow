import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export async function createArtifactStore(runDir) {
    const stepsDir = path.join(runDir, "steps");
    const artifactsDir = path.join(runDir, "artifacts");
    await mkdir(stepsDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    return { root: runDir, stepsDir, artifactsDir };
}
export async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
}
export async function writeStepArtifact(store, stepId, value) {
    const filePath = path.join(store.stepsDir, `${stepId}.json`);
    await writeJson(filePath, sanitizeForUser(value));
    return filePath;
}
export function sanitizeForUser(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForUser(item));
    }
    if (typeof value === "object" && value !== null) {
        const clean = {};
        for (const [key, nested] of Object.entries(value)) {
            if (/secret|token|password|raw_prompt|internal_prompt|debug/i.test(key))
                continue;
            clean[key] = sanitizeForUser(nested);
        }
        return clean;
    }
    return value;
}
//# sourceMappingURL=artifacts.js.map