/**
 * Bakes the pinned external toolchains (Codex CLI, cloudflared,
 * curl-impersonate) into a directory for the container image. Downloads are
 * pinned and integrity-verified by the same installers used at runtime, so
 * the image and a source run install identical artifacts.
 *
 * Usage: bun scripts/bake-toolchains.ts <output-directory> <x64|arm64>
 */
import { fileURLToPath } from "node:url";
import { CodexToolchainManager, readPinnedCodexVersion } from "../src/codex/toolchain.js";
import { ensureCloudflared } from "../src/miniapp/cloudflared.js";
import { Logger } from "../src/shared/logger.js";
import { ensureCurlImpersonate } from "../src/transcription/curl-impersonate.js";

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
await ensureCloudflared(outputDirectory, logger, target);
await ensureCurlImpersonate(outputDirectory, logger, target);
logger.info("Toolchains baked", { outputDirectory, ...target, codexVersion });
