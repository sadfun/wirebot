/** Bun text imports (`with { type: "text" }`) used to embed the Codex pin. */
declare module "*codex.version" {
  const contents: string;
  export default contents;
}

/**
 * Injected with `--define WIREBOT_COMPILED=true` by the compile script.
 * Undefined when running from a source checkout.
 */
declare const WIREBOT_COMPILED: true | undefined;
