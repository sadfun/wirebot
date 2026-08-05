/**
 * Bakes the pinned Codex CLI into a directory for the container image. The
 * download is pinned and integrity-verified by the same installer used at
 * runtime, so the image and a source run install identical artifacts.
 * (cloudflared and curl-impersonate are plain Dockerfile installs.)
 *
 * Usage: bun scripts/bake-toolchains.ts <output-directory> <x64|arm64>
 */
import { fileURLToPath } from "node:url";
import { CodexToolchainManager, readPinnedCodexVersion } from "../src/codex/toolchain.js";
import { Logger } from "../src/shared/logger.js";

const [outputDirectory, arch] = process.argv.slice(2);
if (outputDirectory === undefined || (arch !== "x64" && arch !== "arm64")) {
  console.error("Usage: bun scripts/bake-toolchains.ts <output-directory> <x64|arm64>");
  process.exit(1);
}

const target = { platform: "linux", arch } as const;
const logger = new Logger("info", { component: "bake-toolchains" });
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const codexVersion = await readPinnedCodexVersion(projectRoot);
const manager = new CodexToolchainManager(outputDirectory, logger);
await manager.ensureVersion(codexVersion, target);
logger.info("Toolchains baked", { outputDirectory, ...target, codexVersion });
