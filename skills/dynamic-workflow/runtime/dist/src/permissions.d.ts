import type { PermissionProfileName } from "./types.js";
export interface PermissionProfile {
    name: PermissionProfileName;
    description: string;
    allowedTools: string[];
    canWrite: boolean;
    shell: "none" | "verify-only" | "limited";
    mayReadUntrustedInput: boolean;
}
export declare const PERMISSION_PROFILES: Record<PermissionProfileName, PermissionProfile>;
export declare function isPermissionProfileName(value: string): value is PermissionProfileName;
export declare function listPermissionProfiles(): PermissionProfile[];
//# sourceMappingURL=permissions.d.ts.map