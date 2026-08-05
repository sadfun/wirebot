import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { withTimeout } from "../shared/async.js";
import { externalProcessEnvironment } from "../shared/environment.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { terminateChild } from "../shared/process.js";

const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;
const startTimeoutMs = 30_000;
/** Resolved from PATH; the container image bakes the pinned build into a PATH directory. */
const cloudflaredBinary = "cloudflared";

function extractTryCloudflareUrl(line: string): string | undefined {
  return urlPattern.exec(line)?.[0];
}

export interface QuickTunnelOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
}

/**
 * A best-effort TryCloudflare quick tunnel exposing the Mini App server when no
 * PUBLIC_URL is configured. Quick tunnels need no Cloudflare account, but the
 * URL changes on every start and carries no uptime guarantee.
 */
export class QuickTunnel {
  readonly #options: QuickTunnelOptions;
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  #stopping = false;

  public constructor(options: QuickTunnelOptions) {
    this.#options = options;
  }

  public async start(): Promise<string> {
    if (this.#child !== undefined) {
      throw new BridgeError("Quick tunnel is already started", "TUNNEL_ALREADY_STARTED");
    }

    const origin = `http://${this.#options.host === "0.0.0.0" ? "127.0.0.1" : this.#options.host}:${this.#options.port}`;
    const child = spawn(
      cloudflaredBinary,
      ["tunnel", "--protocol", "http2", "--no-autoupdate", "--url", origin],
      {
        env: externalProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    this.#child = child;

    const url = new Promise<string>((resolve, reject) => {
      const onLine = (line: string): void => {
        this.#options.logger.debug("cloudflared", { line });
        const match = extractTryCloudflareUrl(line);
        if (match !== undefined) resolve(match);
      };
      createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
        "line",
        onLine,
      );
      createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY }).on(
        "line",
        onLine,
      );
      child.once("error", (error) => {
        reject(
          new BridgeError(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "cloudflared is not installed"
              : `cloudflared failed: ${errorMessage(error)}`,
            "TUNNEL_START_FAILED",
          ),
        );
      });
      child.once("exit", (code, signal) => {
        reject(
          new BridgeError(
            `cloudflared exited before publishing a tunnel URL (${signal ?? code})`,
            "TUNNEL_START_FAILED",
          ),
        );
      });
    });

    try {
      const resolved = await withTimeout(
        url,
        startTimeoutMs,
        "Timed out waiting for the TryCloudflare tunnel URL",
      );
      child.once("exit", (code, signal) => {
        if (this.#stopping) return;
        this.#options.logger.warn(
          "The quick tunnel exited; the Mini App URL is unreachable until Wirebot restarts",
          { code, signal },
        );
      });
      return resolved;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    this.#child = undefined;
    await terminateChild(child);
  }
}
