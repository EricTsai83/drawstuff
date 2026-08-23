/**
 * Minimal declaration for the browser-only virtual module vitest serves to
 * tests running under browser mode. It exists only at runtime (the provider
 * aliases it), so the benchmark declares the two members it uses.
 */
declare module "@vitest/browser/context" {
  export const server: { browser: string };
  export const commands: {
    writeFile: (path: string, content: string) => Promise<void>;
  };
}
