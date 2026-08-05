import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { delay } from "../shared/async.js";
import { externalProcessEnvironment } from "../shared/environment.js";
import { BridgeError } from "../shared/errors.js";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";

const registryPackageSchema = z.object({
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/),
});

const installMarkerSchema = z.object({
  version: z.string(),
  installedAt: z.string(),
});

export class CodexToolchainManager {
  readonly #toolchainsDirectory: string;
  readonly #logger: Logger;

  public constructor(toolchainsDirectory: string, logger: Logger) {
    this.#toolchainsDirectory = toolchainsDirectory;
    this.#logger = logger;
  }

  public async latestVersion(): Promise<string> {
    const response = await fetch("https://registry.npmjs.org/@openai%2Fcodex/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new BridgeError(
        `npm registry returned ${response.status} while checking Codex`,
        "CODEX_VERSION_CHECK_FAILED",
      );
    }
    return registryPackageSchema.parse(await response.json()).version;
  }

  public async ensureVersion(version: string): Promise<string> {
    registryPackageSchema.shape.version.parse(version);
    const versionDirectory = join(this.#toolchainsDirectory, version);
    const markerPath = join(versionDirectory, ".wirebot-install.json");
    const binaryPath = this.binaryPath(versionDirectory);
    if (await this.installIsReady(markerPath, binaryPath, version)) return binaryPath;

    await ensureDirectory(this.#toolchainsDirectory);
    const lockPath = join(this.#toolchainsDirectory, `${version}.installing`);
    let ownsLock = false;
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(lockPath);
      ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!ownsLock) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await this.installIsReady(markerPath, binaryPath, version)) return binaryPath;
        await delay(1_000);
      }
      throw new BridgeError(
        `Timed out waiting for Codex ${version} installation`,
        "CODEX_INSTALL_TIMEOUT",
      );
    }

    try {
      if (await this.installIsReady(markerPath, binaryPath, version)) return binaryPath;
      await ensureDirectory(versionDirectory);
      this.#logger.info("Installing isolated Codex CLI", { version });
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      await runCommand(
        npm,
        [
          "install",
          "--prefix",
          versionDirectory,
          "--no-save",
          "--no-package-lock",
          "--omit=dev",
          `@openai/codex@${version}`,
        ],
        { cwd: versionDirectory, env: externalProcessEnvironment() },
      );
      await access(binaryPath);
      await atomicWriteJson(markerPath, {
        version,
        installedAt: new Date().toISOString(),
      });
      return binaryPath;
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private binaryPath(versionDirectory: string): string {
    return join(
      versionDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
  }

  private async installIsReady(
    markerPath: string,
    binaryPath: string,
    version: string,
  ): Promise<boolean> {
    try {
      const marker = installMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
      await access(binaryPath);
      return marker.version === version;
    } catch {
      return false;
    }
  }
}

export async function readPinnedCodexVersion(projectRoot: string): Promise<string> {
  return registryPackageSchema.shape.version.parse(
    (await readFile(join(projectRoot, "codex.version"), "utf8")).trim(),
  );
}
