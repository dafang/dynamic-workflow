export const PERMISSION_PROFILES = {
    classifier: {
        name: "classifier",
        description: "Classifies user requests into deterministic workflow branches.",
        allowedTools: ["artifact.read"],
        canWrite: false,
        shell: "none",
        mayReadUntrustedInput: true
    },
    executor_writer: {
        name: "executor_writer",
        description: "Executes focused implementation tasks through the current host agent.",
        allowedTools: ["artifact.read", "artifact.write", "filesystem.write", "terminal.limited"],
        canWrite: true,
        shell: "limited",
        mayReadUntrustedInput: false
    },
    reviewer_readonly: {
        name: "reviewer_readonly",
        description: "Reviews outputs and repository state without mutation privileges.",
        allowedTools: ["artifact.read", "filesystem.read", "search"],
        canWrite: false,
        shell: "none",
        mayReadUntrustedInput: true
    },
    synthesizer: {
        name: "synthesizer",
        description: "Combines structured outputs and resolves conflicts.",
        allowedTools: ["artifact.read", "artifact.write"],
        canWrite: true,
        shell: "none",
        mayReadUntrustedInput: false
    },
    research: {
        name: "research",
        description: "Reads project and external reference material without changing workspace state.",
        allowedTools: ["artifact.read", "web.search", "filesystem.read"],
        canWrite: false,
        shell: "none",
        mayReadUntrustedInput: true
    },
    command_verifier: {
        name: "command_verifier",
        description: "Runs allowlisted verification commands and records structured results.",
        allowedTools: ["terminal.verify", "artifact.write"],
        canWrite: false,
        shell: "verify-only",
        mayReadUntrustedInput: false
    },
    human_approval: {
        name: "human_approval",
        description: "Pauses execution until a human approves, rejects, or revises a step.",
        allowedTools: ["ask_user"],
        canWrite: false,
        shell: "none",
        mayReadUntrustedInput: true
    }
};
export function isPermissionProfileName(value) {
    return Object.hasOwn(PERMISSION_PROFILES, value);
}
export function listPermissionProfiles() {
    return Object.values(PERMISSION_PROFILES);
}
//# sourceMappingURL=permissions.js.map