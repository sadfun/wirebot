/**
 * Minimal declaration of the Bun runtime surface the build scripts use.
 * The full @types/bun package conflicts with @types/node under
 * skipLibCheck: false, so only what is needed is declared here.
 */
declare const Bun: {
  build(config: {
    entrypoints: readonly string[];
    outdir: string;
    naming?: string;
    target?: "browser" | "bun" | "node";
    format?: "esm" | "cjs" | "iife";
    minify?: boolean;
    sourcemap?: "none" | "linked" | "inline" | "external";
  }): Promise<{
    success: boolean;
    logs: readonly { message: string }[];
  }>;
};
