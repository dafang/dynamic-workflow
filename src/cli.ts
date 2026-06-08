import { compileCommand } from "./commands/compile.js";
import type { CommandContext } from "./commands/common.js";
import { validateCommand } from "./commands/plan.js";
import { resumeCommand } from "./commands/resume.js";
import { reviewCommand } from "./commands/review.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { summarizeCommand } from "./commands/summarize.js";

const HELP = `dynamic-workflow

Usage:
  dw validate <plan>
  dw compile <plan>
  dw run <plan> [--root <dir>]
  dw status <run-id> [--root <dir>]
  dw resume <run-id> [--root <dir>]
  dw review <run-id> [--root <dir>]
  dw summarize <run-id> [--root <dir>]
`;

export async function runCli(argv: string[], context: CommandContext = defaultContext()): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    context.stdout.write(HELP);
    return 0;
  }
  switch (command) {
    case "validate":
      return validateCommand(args, context);
    case "compile":
      return compileCommand(args, context);
    case "run":
      return runCommand(args, context);
    case "status":
      return statusCommand(args, context);
    case "resume":
      return resumeCommand(args, context);
    case "review":
      return reviewCommand(args, context);
    case "summarize":
      return summarizeCommand(args, context);
    default:
      context.stderr.write(`Unknown command: ${command}\n${HELP}`);
      return 2;
  }
}

function defaultContext(): CommandContext {
  return {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr
  };
}
