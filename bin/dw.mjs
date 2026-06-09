#!/usr/bin/env node
import { runCli } from "../dist/src/cli.js";

process.stdout.on("error", handleBrokenPipe);
process.stderr.on("error", handleBrokenPipe);

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;

function handleBrokenPipe(error) {
  if (error?.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
}
