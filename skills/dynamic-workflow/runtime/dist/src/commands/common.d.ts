export interface CommandContext {
    cwd: string;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
}
export declare function readPlanFile(filePath: string): Promise<unknown>;
export declare function parseRootFlag(args: string[]): {
    rootDir: string | undefined;
    rest: string[];
};
export declare function writeJson(stdout: NodeJS.WritableStream, value: unknown): void;
//# sourceMappingURL=common.d.ts.map