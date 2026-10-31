export const PROJECT_ROOT: string;
export function runtimeDirectory(): string;
export function capabilityPath(port: number): string;
export function ensurePrivateDirectory(path: string): void;
export function prepareRuntimeDirectory(): string;
export function readTutorCapability(port: number, path?: string): Promise<string>;
