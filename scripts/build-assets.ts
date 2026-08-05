/**
 * Builds the Mini App browser assets into dist/miniapp/public: copies
 * index.html and bundles client.tsx with Bun. The Tailwind CSS step runs
 * separately in the package build script.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDirectory = `${projectRoot}src/miniapp`;
const outputDirectory = `${projectRoot}dist/miniapp/public`;

await mkdir(outputDirectory, { recursive: true });
await copyFile(`${sourceDirectory}/index.html`, `${outputDirectory}/index.html`);

const result = await Bun.build({
  entrypoints: [`${sourceDirectory}/client.tsx`],
  outdir: outputDirectory,
  naming: "app.[ext]",
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}
