import type { JsonObject } from "./types.js";
export interface ArtifactStore {
    root: string;
    stepsDir: string;
    artifactsDir: string;
}
export declare function createArtifactStore(runDir: string): Promise<ArtifactStore>;
export declare function writeJson(filePath: string, value: unknown): Promise<void>;
export declare function readJson<T>(filePath: string): Promise<T>;
export declare function writeStepArtifact(store: ArtifactStore, stepId: string, value: JsonObject): Promise<string>;
export declare function sanitizeForUser<T>(value: T): T;
//# sourceMappingURL=artifacts.d.ts.map