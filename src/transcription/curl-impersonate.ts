import { createHash } from "node:crypto";
import { access, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError, errorMessage } from "../shared/errors.js";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";

/**
 * Pinned browser-fingerprinted transport used for ChatGPT dictation. The
 * checksums are GitHub's published SHA-256 asset digests for
 * https://github.com/lexiforest/curl-impersonate/releases/tag/v1.5.6.
 */
export const curlImpersonateVersion = "1.5.6";
export const curlImpersonateTarget = "chrome146";

interface CurlImpersonateAsset {
  readonly name: string;
  readonly sha256: string;
}

const assets: Readonly<Record<string, CurlImpersonateAsset>> = {
  "darwin-arm64": {
    name: "curl-impersonate-v1.5.6.arm64-macos.tar.gz",
    sha256: "8960639189747306262fd26cfdc3f5ece52c300257c448a2171252c1060f3f04",
  },
  "darwin-x64": {
    name: "curl-impersonate-v1.5.6.x86_64-macos.tar.gz",
    sha256: "e652f640ec5865b70ee409d76769193bb8caf4b6d4b714727807f74428b46908",
  },
  // The musl builds are statically linked, so the same assets work on glibc
  // and musl distributions without adding host-library requirements.
  "linux-arm64": {
    name: "curl-impersonate-v1.5.6.aarch64-linux-musl.tar.gz",
    sha256: "09705dbc58b9df3fc522e59b17929cc5f45f1f76bcff72d92914066fce7b0986",
  },
  "linux-x64": {
    name: "curl-impersonate-v1.5.6.x86_64-linux-musl.tar.gz",
    sha256: "186140c3567c1ace7d0cac4703eb9e47ce6984956f8cc623e404a094e788b602",
  },
};

const installMarkerSchema = z.object({
  version: z.string(),
  installedAt: z.string(),
});

export function curlImpersonateAssetFor(
  platform: string = process.platform,
  arch: string = process.arch,
): CurlImpersonateAsset | undefined {
  return assets[`${platform}-${arch}`];
}

/**
 * Downloads and verifies the pinned curl-impersonate build on first use.
 * A target other than the host is only used when baking container images.
 */
export async function ensureCurlImpersonate(
  toolchainsDirectory: string,
  logger: Logger,
  target: { readonly platform: string; readonly arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): Promise<string> {
  const asset = curlImpersonateAssetFor(target.platform, target.arch);
  if (asset === undefined) {
    throw new BridgeError(
      `Voice transcription is not supported on ${target.platform}-${target.arch}`,
      "TRANSCRIPTION_UNSUPPORTED_PLATFORM",
    );
  }

  const versionDirectory = join(toolchainsDirectory, `curl-impersonate-${curlImpersonateVersion}`);
  const binaryPath = join(versionDirectory, "curl-impersonate");
  const markerPath = join(versionDirectory, ".wirebot-install.json");
  if (await installIsReady(markerPath, binaryPath)) return binaryPath;

  await ensureDirectory(versionDirectory);
  logger.info("Downloading the voice transcription transport", {
    version: curlImpersonateVersion,
    asset: asset.name,
  });
  const url = `https://github.com/lexiforest/curl-impersonate/releases/download/v${curlImpersonateVersion}/${asset.name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new BridgeError(
      `GitHub returned ${response.status} while downloading ${asset.name}`,
      "TRANSCRIPTION_TRANSPORT_DOWNLOAD_FAILED",
    );
  }
  const payload = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(payload).digest("hex");
  if (actual !== asset.sha256) {
    throw new BridgeError(
      `Checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`,
      "TRANSCRIPTION_TRANSPORT_CHECKSUM_MISMATCH",
    );
  }

  try {
    const archivePath = join(versionDirectory, asset.name);
    await writeFile(archivePath, payload);
    await runCommand(
      "tar",
      [
        "-xzf",
        asset.name,
        ...(target.platform === "linux" ? ["--no-same-owner"] : []),
        "curl-impersonate",
      ],
      {
        cwd: versionDirectory,
      },
    );
    await rm(archivePath, { force: true });
    await chmod(binaryPath, 0o755);
    await access(binaryPath);
    await atomicWriteJson(markerPath, {
      version: curlImpersonateVersion,
      installedAt: new Date().toISOString(),
    });
    return binaryPath;
  } catch (error) {
    await rm(versionDirectory, { recursive: true, force: true });
    throw new BridgeError(
      `Failed to install the voice transcription transport: ${errorMessage(error)}`,
      "TRANSCRIPTION_TRANSPORT_INSTALL_FAILED",
    );
  }
}

async function installIsReady(markerPath: string, binaryPath: string): Promise<boolean> {
  try {
    const marker = installMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
    await access(binaryPath);
    return marker.version === curlImpersonateVersion;
  } catch {
    return false;
  }
}
