import { readFile } from "node:fs/promises";
import YAML from "yaml";
export async function readPlanFile(filePath) {
    const text = await readFile(filePath, "utf8");
    if (filePath.endsWith(".json")) {
        return JSON.parse(text);
    }
    return YAML.parse(text);
}
export function parseRootFlag(args) {
    const rest = [];
    let rootDir;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined)
            continue;
        if (arg === "--root") {
            const value = args[index + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new Error("--root requires a directory value.");
            }
            rootDir = value;
            index += 1;
            continue;
        }
        rest.push(arg);
    }
    return { rootDir, rest };
}
export function writeJson(stdout, value) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
//# sourceMappingURL=common.js.map