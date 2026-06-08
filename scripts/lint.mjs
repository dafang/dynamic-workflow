#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const checkedExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md", ".yaml", ".yml"]);
const ignoredDirs = new Set(["node_modules", "dist", ".dynamic-workflow", ".git"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }
    if (checkedExtensions.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

const failures = [];

for await (const file of walk(root)) {
  const text = await readFile(file, "utf8");
  const relative = path.relative(root, file);
  if (/\r\n?/.test(text)) {
    failures.push(`${relative}: contains CRLF or CR line endings`);
  }
  if (/[ \t]$/m.test(text)) {
    failures.push(`${relative}: contains trailing whitespace`);
  }
  if (!text.endsWith("\n")) {
    failures.push(`${relative}: missing final newline`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log("lint ok");
