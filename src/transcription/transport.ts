import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { externalProcessEnvironment } from "../shared/environment.js";
import { BridgeError } from "../shared/errors.js";

export interface TranscriptionRequest {
  readonly path: string;
  readonly accessToken: string;
  readonly accountId: string;
}

export interface TranscriptionResponse {
  readonly status: number;
  readonly body: string;
}

export interface TranscriptionTransport {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse>;
}

const responseLimit = 1 * 1_024 * 1_024;
const requestTimeoutMs = 90_000;
/** Resolved from PATH; the container image installs the pinned build there (see Dockerfile). */
const curlImpersonateBinary = "curl-impersonate";
/** Browser fingerprint supported by the pinned curl-impersonate build. */
const curlImpersonateTarget = "chrome146";

export class CurlImpersonateTransport implements TranscriptionTransport {
  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const delimiter = `--wirebot-http-status-${crypto.randomUUID()}--`;
    const result = await runCurl(
      curlImpersonateBinary,
      [
        "--impersonate",
        curlImpersonateTarget,
        "--compressed",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "15",
        "--max-time",
        String(requestTimeoutMs / 1_000),
        "--request",
        "POST",
        "--form",
        `file=@${quoteFormPath(request.path)};type=audio/ogg;filename=voice.ogg`,
        "--write-out",
        `\n${delimiter}%{http_code}`,
        "--config",
        "-",
        "https://chatgpt.com/backend-api/transcribe",
      ],
      [
        curlConfigHeader("Authorization", `Bearer ${request.accessToken}`),
        curlConfigHeader("ChatGPT-Account-Id", request.accountId),
        curlConfigHeader("originator", "Wirebot"),
        curlConfigHeader("accept", "application/json"),
      ].join("\n"),
      dirname(request.path),
    );
    const marker = result.stdout.lastIndexOf(`\n${delimiter}`);
    if (marker < 0) {
      throw new BridgeError(
        "The transcription transport returned an unreadable response",
        "TRANSCRIPTION_TRANSPORT_INVALID_RESPONSE",
      );
    }
    const statusText = result.stdout.slice(marker + delimiter.length + 1).trim();
    const status = Number.parseInt(statusText, 10);
    if (!Number.isInteger(status)) {
      throw new BridgeError(
        "The transcription transport did not return an HTTP status",
        "TRANSCRIPTION_TRANSPORT_INVALID_STATUS",
      );
    }
    return { status, body: result.stdout.slice(0, marker) };
  }
}

function curlConfigHeader(name: string, value: string): string {
  if (/\r|\n/u.test(value)) {
    throw new BridgeError("Invalid transcription credential", "TRANSCRIPTION_INVALID_CREDENTIAL");
  }
  return `header = "${`${name}: ${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteFormPath(path: string): string {
  if (/\r|\n/u.test(path)) {
    throw new BridgeError("Invalid voice-message path", "TRANSCRIPTION_INVALID_PATH");
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface CurlResult {
  readonly stdout: string;
}

async function runCurl(
  binary: string,
  args: readonly string[],
  config: string,
  cwd: string,
): Promise<CurlResult> {
  return await new Promise<CurlResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: externalProcessEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, requestTimeoutMs + 1_000);
    timer.unref();

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect =
      (target: Buffer[]) =>
      (chunk: Buffer): void => {
        outputSize += chunk.byteLength;
        if (outputSize > responseLimit) {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new BridgeError(
                "The transcription transport returned too much data",
                "TRANSCRIPTION_TRANSPORT_RESPONSE_TOO_LARGE",
              ),
            ),
          );
          return;
        }
        target.push(chunk);
      };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.once("error", (error) =>
      finish(() =>
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new BridgeError(
                "This deployment has no curl-impersonate transcription transport",
                "TRANSCRIPTION_UNAVAILABLE",
              )
            : error,
        ),
      ),
    );
    child.once("exit", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
        reject(
          new BridgeError(
            `Voice transcription transport exited with ${code ?? signal ?? "unknown"}${detail.length === 0 ? "" : `: ${detail}`}`,
            "TRANSCRIPTION_TRANSPORT_FAILED",
          ),
        );
      });
    });
    child.stdin.end(config);
  });
}
