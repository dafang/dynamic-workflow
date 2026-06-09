import type { PermissionProfileName, StepType } from "./types.js";

export interface StepTypeDefinition {
  type: StepType;
  description: string;
  defaultPermissionProfile: PermissionProfileName;
  allowedPermissionProfiles: PermissionProfileName[];
  control: boolean;
  concurrent: boolean;
  mayWrite: boolean;
  supportsRetry: boolean;
  defaultTimeoutSeconds: number;
}

export const STEP_REGISTRY: Record<StepType, StepTypeDefinition> = {
  "agent.classify": {
    type: "agent.classify",
    description: "Classify input into labels or branches.",
    defaultPermissionProfile: "classifier",
    allowedPermissionProfiles: ["classifier", "research"],
    control: false,
    concurrent: true,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 300
  },
  "agent.execute": {
    type: "agent.execute",
    description: "Execute a focused implementation step via the current host agent.",
    defaultPermissionProfile: "executor_writer",
    allowedPermissionProfiles: ["executor_writer"],
    control: false,
    concurrent: false,
    mayWrite: true,
    supportsRetry: true,
    defaultTimeoutSeconds: 1800
  },
  "agent.review": {
    type: "agent.review",
    description: "Perform readonly adversarial or quality review.",
    defaultPermissionProfile: "reviewer_readonly",
    allowedPermissionProfiles: ["reviewer_readonly", "research"],
    control: false,
    concurrent: true,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 900
  },
  "agent.synthesize": {
    type: "agent.synthesize",
    description: "Merge structured outputs into a final answer or artifact.",
    defaultPermissionProfile: "synthesizer",
    allowedPermissionProfiles: ["synthesizer"],
    control: false,
    concurrent: false,
    mayWrite: true,
    supportsRetry: true,
    defaultTimeoutSeconds: 900
  },
  "agent.generate": {
    type: "agent.generate",
    description: "Generate candidate plans, options, or artifacts.",
    defaultPermissionProfile: "research",
    allowedPermissionProfiles: ["research", "executor_writer"],
    control: false,
    concurrent: true,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 900
  },
  "agent.filter": {
    type: "agent.filter",
    description: "Filter or rank candidate outputs against criteria.",
    defaultPermissionProfile: "synthesizer",
    allowedPermissionProfiles: ["synthesizer", "reviewer_readonly"],
    control: false,
    concurrent: false,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 600
  },
  "agent.judge_pair": {
    type: "agent.judge_pair",
    description: "Judge two candidates and emit a structured winner.",
    defaultPermissionProfile: "reviewer_readonly",
    allowedPermissionProfiles: ["reviewer_readonly"],
    control: false,
    concurrent: true,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 600
  },
  "workflow.include": {
    type: "workflow.include",
    description: "Compile an allowlisted built-in workflow into the graph.",
    defaultPermissionProfile: "synthesizer",
    allowedPermissionProfiles: ["synthesizer"],
    control: true,
    concurrent: false,
    mayWrite: false,
    supportsRetry: false,
    defaultTimeoutSeconds: 60
  },
  "workflow.loop": {
    type: "workflow.loop",
    description: "Compile a bounded loop into resumable rounds.",
    defaultPermissionProfile: "synthesizer",
    allowedPermissionProfiles: ["synthesizer"],
    control: true,
    concurrent: false,
    mayWrite: false,
    supportsRetry: false,
    defaultTimeoutSeconds: 60
  },
  "workflow.tournament": {
    type: "workflow.tournament",
    description: "Compile candidate comparisons into pairwise judge steps.",
    defaultPermissionProfile: "synthesizer",
    allowedPermissionProfiles: ["synthesizer"],
    control: true,
    concurrent: false,
    mayWrite: false,
    supportsRetry: false,
    defaultTimeoutSeconds: 60
  },
  "command.verify": {
    type: "command.verify",
    description: "Run allowlisted verification commands and capture results.",
    defaultPermissionProfile: "command_verifier",
    allowedPermissionProfiles: ["command_verifier"],
    control: false,
    concurrent: false,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 600
  },
  "command.collect": {
    type: "command.collect",
    description: "Run bounded evidence collection commands and preserve partial results.",
    defaultPermissionProfile: "command_collector",
    allowedPermissionProfiles: ["command_collector"],
    control: false,
    concurrent: true,
    mayWrite: false,
    supportsRetry: true,
    defaultTimeoutSeconds: 600
  },
  "human.approval": {
    type: "human.approval",
    description: "Pause for human approval.",
    defaultPermissionProfile: "human_approval",
    allowedPermissionProfiles: ["human_approval"],
    control: false,
    concurrent: false,
    mayWrite: false,
    supportsRetry: false,
    defaultTimeoutSeconds: 86400
  }
};

export function isStepType(value: string): value is StepType {
  return Object.hasOwn(STEP_REGISTRY, value);
}

export function getStepDefinition(type: StepType): StepTypeDefinition {
  return STEP_REGISTRY[type];
}

export function listStepTypes(): StepTypeDefinition[] {
  return Object.values(STEP_REGISTRY);
}
