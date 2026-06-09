import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const skillRoot = path.join(repoRoot, "skills", "dynamic-workflow");
const runtimeRoot = path.join(skillRoot, "runtime");

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(path.join(runtimeRoot, "bin"), { recursive: true });
await mkdir(path.join(runtimeRoot, "node_modules"), { recursive: true });

await cp(path.join(repoRoot, "bin", "dw.mjs"), path.join(runtimeRoot, "bin", "dw.mjs"));
await cp(path.join(repoRoot, "dist", "src"), path.join(runtimeRoot, "dist", "src"), { recursive: true });
await cp(path.join(repoRoot, "node_modules", "yaml"), path.join(runtimeRoot, "node_modules", "yaml"), { recursive: true });

await writeFile(
  path.join(runtimeRoot, "package.json"),
  `${JSON.stringify(
    {
      type: "module",
      private: true,
      dependencies: {
        yaml: "^2.9.0"
      }
    },
    null,
    2
  )}\n`,
  "utf8"
);

await normalizePackagedText(runtimeRoot);

async function normalizePackagedText(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await normalizePackagedText(filePath);
      continue;
    }
    if (!shouldNormalize(entry.name)) {
      continue;
    }
    const text = await readFile(filePath, "utf8");
    const normalized = text.replace(/[ \t]+$/gm, "");
    if (normalized !== text) {
      await writeFile(filePath, normalized, "utf8");
    }
  }
}

function shouldNormalize(fileName) {
  const ext = path.extname(fileName);
  return [".js", ".mjs", ".ts", ".json", ".md", ".txt", ".yaml", ".yml"].includes(ext) || fileName === "LICENSE";
}
