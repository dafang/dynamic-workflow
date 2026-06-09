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
export declare const STEP_REGISTRY: Record<StepType, StepTypeDefinition>;
export declare function isStepType(value: string): value is StepType;
export declare function getStepDefinition(type: StepType): StepTypeDefinition;
export declare function listStepTypes(): StepTypeDefinition[];
//# sourceMappingURL=registry.d.ts.map