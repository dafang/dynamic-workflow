import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export class CurrentBackend {
    name = "current";
    async executeStep(node, context) {
        if (node.type === "human.approval") {
            return {
                status: "waiting_user",
                summary: "Waiting for human approval.",
                output: { status: "waiting_user", step_id: node.step_id }
            };
        }
        if (node.type === "command.verify") {
            return executeVerifyCommands(node);
        }
        if (node.input.force_fail === true) {
            return {
                status: "failed",
                summary: `Step ${node.step_id} failed by fixture request.`,
                output: { status: "failed", step_id: node.step_id, reason: "force_fail" }
            };
        }
        return {
            status: "succeeded",
            summary: `Executed ${node.step_id} through current host boundary.`,
            output: {
                status: "succeeded",
                step_id: node.step_id,
                type: node.type,
                summary: `Executed ${node.step_id} through current host boundary.`,
                context: context.inputs,
                context_sources: context.sources.map((source) => ({ ...source })),
                artifacts: []
            }
        };
    }
}
async function executeVerifyCommands(node) {
    const commands = getVerifyCommands(node);
    if (commands.length === 0) {
        return {
            status: "failed",
            summary: "Verification step did not declare any commands.",
            output: { status: "failed", step_id: node.step_id, checks: [], reason: "missing_verify_commands" },
            verify: { ok: false, checks: [] }
        };
    }
    const checks = [];
    for (const command of commands) {
        const result = await runShell(command);
        checks.push(result);
        if (result.exit_code !== 0) {
            return {
                status: "failed",
                summary: `Verification command failed: ${command}`,
                output: { status: "failed", step_id: node.step_id, checks },
                verify: { ok: false, checks }
            };
        }
    }
    return {
        status: "succeeded",
        summary: "Verification commands passed.",
        output: { status: "succeeded", step_id: node.step_id, checks },
        verify: { ok: true, checks }
    };
}
function getVerifyCommands(node) {
    if (Array.isArray(node.verify?.commands)) {
        return node.verify.commands;
    }
    if (Array.isArray(node.input.commands)) {
        return node.input.commands.filter((command) => typeof command === "string");
    }
    return [];
}
async function runShell(command) {
    try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", command], { timeout: 120_000 });
        return { command, exit_code: 0, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
    }
    catch (error) {
        const failed = error;
        return {
            command,
            exit_code: typeof failed.code === "number" ? failed.code : 1,
            stdout: (failed.stdout ?? "").slice(-2000),
            stderr: (failed.stderr ?? failed.message).slice(-2000)
        };
    }
}
//# sourceMappingURL=current.js.map