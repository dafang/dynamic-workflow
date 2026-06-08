import { readFile } from "node:fs/promises";
import YAML from "yaml";

export interface CommandContext {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function readPlanFile(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    return JSON.parse(text);
  }
  return YAML.parse(text) as unknown;
}

export function parseRootFlag(args: string[]): { rootDir: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let rootDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
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

export function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
