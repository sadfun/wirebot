import { createHash } from "node:crypto";
import { access, chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError, errorMessage } from "../shared/errors.js";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";

/**
 * Pinned cloudflared release used for the automatic TryCloudflare quick
 * tunnel. Checksums are GitHub's published SHA-256 asset digests for
 * https://github.com/cloudflare/cloudflared/releases/tag/2026.7.2 — update
 * both together.
 */
export const cloudflaredVersion = "2026.7.2";

interface CloudflaredAsset {
  readonly name: string;
  readonly sha256: string;
  readonly archive: "tgz" | "binary";
}

const assets: Readonly<Record<string, CloudflaredAsset>> = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "2086e51c61d6565781d84117a5007d0c826d03ffdc74acb91c08c167f9f8cd7c",
    archive: "tgz",
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "4ee0d3b48a990a2f9b5faec5838f73ec1f400aa8e0a4864be576adfafec406cb",
    archive: "tgz",
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
    archive: "binary",
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
    archive: "binary",
  },
  "linux-arm": {
    name: "cloudflared-linux-armhf",
    sha256: "e4f86d1a24cfcd065268f2bc874d0510f278f12842c0d220ce6e887489b16a70",
    archive: "binary",
  },
  "linux-ia32": {
    name: "cloudflared-linux-386",
    sha256: "cbad04f2700ae4d4971fe07e9ded67327142f2d3338aef86ae04e6042f7ce990",
    archive: "binary",
  },
};

const installMarkerSchema = z.object({
  version: z.string(),
  installedAt: z.string(),
});

export function cloudflaredAssetFor(
  platform: string = process.platform,
  arch: string = process.arch,
): CloudflaredAsset | undefined {
  return assets[`${platform}-${arch}`];
}

async function cloudflaredOnPath(): Promise<string | undefined> {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const result = await runCommand(which, ["cloudflared"], { cwd: process.cwd() });
    const first = result.stdout.split(/\r?\n/u, 1)[0]?.trim();
    return first === undefined || first.length === 0 ? undefined : first;
  } catch {
    return undefined;
  }
}

/**
 * Returns a cloudflared binary path: the one on PATH when present, otherwise
 * a pinned, checksum-verified download into the app-owned toolchains
 * directory. Throws when the platform is unsupported or the download fails.
 */
export async function ensureCloudflared(
  toolchainsDirectory: string,
  logger: Logger,
): Promise<string> {
  const existing = await cloudflaredOnPath();
  if (existing !== undefined) {
    logger.debug("Using cloudflared from PATH", { path: existing });
    return existing;
  }

  const asset = cloudflaredAssetFor();
  if (asset === undefined) {
    throw new BridgeError(
      `No pinned cloudflared build for ${process.platform}-${process.arch}; install cloudflared manually`,
      "CLOUDFLARED_UNSUPPORTED_PLATFORM",
    );
  }

  const versionDirectory = join(toolchainsDirectory, `cloudflared-${cloudflaredVersion}`);
  const binaryPath = join(versionDirectory, "cloudflared");
  const markerPath = join(versionDirectory, ".wirebot-install.json");
  if (await installIsReady(markerPath, binaryPath)) return binaryPath;

  await ensureDirectory(versionDirectory);
  logger.info("Downloading cloudflared for the quick tunnel", {
    version: cloudflaredVersion,
    asset: asset.name,
  });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/${asset.name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new BridgeError(
      `GitHub returned ${response.status} while downloading ${asset.name}`,
      "CLOUDFLARED_DOWNLOAD_FAILED",
    );
  }
  const payload = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(payload).digest("hex");
  if (actual !== asset.sha256) {
    throw new BridgeError(
      `Checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`,
      "CLOUDFLARED_CHECKSUM_MISMATCH",
    );
  }

  try {
    if (asset.archive === "tgz") {
      const archivePath = join(versionDirectory, asset.name);
      await writeFile(archivePath, payload);
      await runCommand("tar", ["-xzf", asset.name], { cwd: versionDirectory });
      await rm(archivePath, { force: true });
    } else {
      const stagingPath = `${binaryPath}.download`;
      await writeFile(stagingPath, payload);
      await rename(stagingPath, binaryPath);
    }
    await chmod(binaryPath, 0o755);
    await access(binaryPath);
    await atomicWriteJson(markerPath, {
      version: cloudflaredVersion,
      installedAt: new Date().toISOString(),
    });
    return binaryPath;
  } catch (error) {
    await rm(versionDirectory, { recursive: true, force: true });
    throw new BridgeError(
      `Failed to install cloudflared ${cloudflaredVersion}: ${errorMessage(error)}`,
      "CLOUDFLARED_INSTALL_FAILED",
    );
  }
}

async function installIsReady(markerPath: string, binaryPath: string): Promise<boolean> {
  try {
    const marker = installMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
    await access(binaryPath);
    return marker.version === cloudflaredVersion;
  } catch {
    return false;
  }
}
