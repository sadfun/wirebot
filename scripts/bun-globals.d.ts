/**
 * Minimal declaration of the Bun runtime surface the project uses.
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
  markdown: {
    render(
      input: string,
      callbacks: Readonly<{
        link?: (
          children: string,
          meta: Readonly<{ href: string; title?: string }>,
        ) => string | null | undefined;
        image?: (
          children: string,
          meta: Readonly<{ src: string; title?: string }>,
        ) => string | null | undefined;
      }>,
    ): string;
  };
  Archive: {
    new (
      data: Blob | ArrayBufferLike | Uint8Array<ArrayBufferLike>,
    ): {
      extract(
        path: string,
        options?: Readonly<{ glob?: string | readonly string[] }>,
      ): Promise<number>;
    };
  };
};
