import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import pinnedCodexVersionText from "../../codex.version" with { type: "text" };
import { delay } from "../shared/async.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";

const versionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);

const registryPackageSchema = z.object({ version: versionSchema });

const registryVersionSchema = z.object({
  dist: z.object({
    tarball: z.url(),
    integrity: z.string().startsWith("sha512-"),
  }),
});

const installMarkerSchema = z.object({
  version: z.string(),
  target: z.string(),
  installedAt: z.string(),
});

interface InstallMarker {
  readonly version: string;
  readonly target: string;
}

/** True when the marker matches `expected` and the installed binary exists. */
async function installIsReady(
  markerPath: string,
  binaryPath: string,
  expected: InstallMarker,
): Promise<boolean> {
  try {
    const marker = installMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
    await access(binaryPath);
    return marker.version === expected.version && marker.target === expected.target;
  } catch {
    return false;
  }
}

/**
 * Codex publishes its native binaries as npm platform packages versioned
 * `<version>-<platform>-<arch>` under @openai/codex; each ships a
 * self-contained `vendor/<triple>/` tree (codex, bwrap, rg, zsh). Wirebot
 * downloads that tarball straight from the registry — verified against the
 * registry's own integrity digest — so neither Node nor npm is needed.
 */
export interface CodexTarget {
  readonly platform: "darwin" | "linux";
  readonly arch: "x64" | "arm64";
}

const vendorTriples: Readonly<Record<string, string>> = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

/** The Codex CLI version this Wirebot build is pinned to, embedded at build time. */
export const pinnedCodexVersion: string = versionSchema.parse(pinnedCodexVersionText.trim());

function hostCodexTarget(): CodexTarget {
  const target = { platform: process.platform, arch: process.arch };
  if (vendorTriples[`${target.platform}-${target.arch}`] === undefined) {
    throw new BridgeError(
      `No Codex CLI build for ${target.platform}-${target.arch}`,
      "CODEX_UNSUPPORTED_PLATFORM",
    );
  }
  return target as CodexTarget;
}

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

  public async ensureVersion(
    version: string,
    target: CodexTarget = hostCodexTarget(),
  ): Promise<string> {
    versionSchema.parse(version);
    const versionDirectory = join(this.#toolchainsDirectory, version);
    const markerPath = join(versionDirectory, ".wirebot-install.json");
    const binaryPath = this.binaryPath(versionDirectory, target);
    const expectedMarker = { version, target: targetKey(target) } as const;
    if (await installIsReady(markerPath, binaryPath, expectedMarker)) return binaryPath;

    await ensureDirectory(this.#toolchainsDirectory);
    const lockPath = join(this.#toolchainsDirectory, `${version}.installing`);
    let ownsLock = false;
    try {
      await mkdir(lockPath);
      ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!ownsLock) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await installIsReady(markerPath, binaryPath, expectedMarker)) return binaryPath;
        await delay(1_000);
      }
      throw new BridgeError(
        `Timed out waiting for Codex ${version} installation`,
        "CODEX_INSTALL_TIMEOUT",
      );
    }

    try {
      if (await installIsReady(markerPath, binaryPath, expectedMarker)) return binaryPath;
      this.#logger.info("Installing isolated Codex CLI", { version, ...target });
      await this.install(version, target, versionDirectory);
      await access(binaryPath);
      await atomicWriteJson(markerPath, {
        ...expectedMarker,
        installedAt: new Date().toISOString(),
      });
      return binaryPath;
    } catch (error) {
      await rm(versionDirectory, { recursive: true, force: true });
      throw new BridgeError(
        `Failed to install Codex ${version}: ${errorMessage(error)}`,
        "CODEX_INSTALL_FAILED",
      );
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async install(
    version: string,
    target: CodexTarget,
    versionDirectory: string,
  ): Promise<void> {
    const platformVersion = `${version}-${target.platform}-${target.arch}`;
    const metadataResponse = await fetch(
      `https://registry.npmjs.org/@openai%2Fcodex/${platformVersion}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
    );
    if (!metadataResponse.ok) {
      throw new BridgeError(
        `npm registry returned ${metadataResponse.status} for @openai/codex@${platformVersion}`,
        "CODEX_DOWNLOAD_FAILED",
      );
    }
    const { dist } = registryVersionSchema.parse(await metadataResponse.json());

    const response = await fetch(dist.tarball, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) {
      throw new BridgeError(
        `npm registry returned ${response.status} while downloading Codex ${platformVersion}`,
        "CODEX_DOWNLOAD_FAILED",
      );
    }
    const payload = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha512").update(payload).digest("base64");
    const expected = dist.integrity.slice("sha512-".length);
    if (actual !== expected) {
      throw new BridgeError(
        `Integrity mismatch for Codex ${platformVersion}: expected ${expected}, got ${actual}`,
        "CODEX_CHECKSUM_MISMATCH",
      );
    }

    const stageDirectory = `${versionDirectory}.stage`;
    await rm(stageDirectory, { recursive: true, force: true });
    await new Bun.Archive(payload).extract(stageDirectory, { glob: "package/vendor/**" });
    await rm(versionDirectory, { recursive: true, force: true });
    await rename(join(stageDirectory, "package"), versionDirectory);
    await rm(stageDirectory, { recursive: true, force: true });
  }

  private binaryPath(versionDirectory: string, target: CodexTarget): string {
    const triple = vendorTriples[targetKey(target)];
    if (triple === undefined) {
      throw new BridgeError(
        `No Codex CLI build for ${targetKey(target)}`,
        "CODEX_UNSUPPORTED_PLATFORM",
      );
    }
    return join(versionDirectory, "vendor", triple, "bin", "codex");
  }
}

function targetKey(target: CodexTarget): string {
  return `${target.platform}-${target.arch}`;
}

export async function readPinnedCodexVersion(projectRoot: string): Promise<string> {
  return versionSchema.parse((await readFile(join(projectRoot, "codex.version"), "utf8")).trim());
}
