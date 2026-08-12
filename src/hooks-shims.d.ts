/**
 * Ambient type shims for the plain-JS hook modules server.ts reuses at
 * runtime (routing-block sizing for the net-savings overhead accounting).
 * These modules live under hooks/, outside tsconfig's rootDir — an ambient
 * declaration here lets tsc type-check the import without trying to
 * compile hooks/*.mjs as part of the src/ program.
 */
declare module "../hooks/routing-block.mjs" {
  export function getRoutingBlockMode(): string;
  export function createRoutingBlock(
    t: (bareTool: string) => string,
    options?: { mode?: string; includeCommands?: boolean; toolSearchBootstrap?: boolean },
  ): string;
  export function createSubagentPointer(
    t: (bareTool: string) => string,
    options?: { toolSearchBootstrap?: boolean },
  ): string;
}

declare module "../hooks/core/tool-naming.mjs" {
  export function createToolNamer(platform: string): (bareTool: string) => string;
  export const KNOWN_PLATFORMS: string[];
}
