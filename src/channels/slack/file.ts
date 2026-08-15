import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describeSlackFile, type SlackFile } from "./message.js";

const slackFileSizeLimit = 100 * 1_024 * 1_024;
const slackFileDownloadTimeoutMs = 30_000;

export class SlackFileDownloadError extends Error {
  public readonly userMessage: string;

  public constructor(message: string, userMessage: string) {
    super(message);
    this.name = "SlackFileDownloadError";
    this.userMessage = userMessage;
  }
}

interface DownloadOptions {
  readonly botToken: string;
  readonly directory: string;
  readonly index: number;
}

export async function downloadSlackFile(
  file: SlackFile,
  options: DownloadOptions,
): Promise<string> {
  const description = describeSlackFile(file);
  const url = file.url_private_download ?? file.url_private;
  if (url === undefined) {
    throw new SlackFileDownloadError(
      `Slack did not provide a download URL for ${description}`,
      "Slack did not make the file downloadable",
    );
  }
  // The bot token travels in the Authorization header, so only send it to
  // Slack's own file hosts.
  if (!isSlackFileHost(url)) {
    throw new SlackFileDownloadError(
      `Refused to download ${description} from a non-Slack host`,
      "its download URL does not point at Slack",
    );
  }
  if ((file.size ?? 0) > slackFileSizeLimit) {
    throw new SlackFileDownloadError(
      `${description} exceeds the download size limit`,
      `it is larger than the ${Math.round(slackFileSizeLimit / (1_024 * 1_024))} MB download limit`,
    );
  }

  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const target = join(
    options.directory,
    `${String(options.index + 1).padStart(2, "0")}-${safeName(file.name ?? file.title ?? "", url)}`,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${options.botToken}` },
      signal: AbortSignal.timeout(slackFileDownloadTimeoutMs),
    });
  } catch {
    throw new SlackFileDownloadError(
      `The download request for ${description} failed`,
      "Slack's file download request failed",
    );
  }
  if (!response.ok || response.body === null) {
    throw new SlackFileDownloadError(
      `Slack returned HTTP ${response.status} for ${description}`,
      `Slack's file server returned HTTP ${response.status}`,
    );
  }
  // Without the files:read scope Slack redirects to an HTML sign-in page
  // instead of failing the request.
  if (response.headers.get("content-type")?.toLowerCase().includes("text/html") === true) {
    throw new SlackFileDownloadError(
      `Slack served an HTML page instead of ${description}`,
      "Slack denied the download; check that the app has the files:read scope",
    );
  }

  try {
    // Slack's reported size is advisory; count the actual bytes so a
    // mismatched or missing size cannot exhaust the disk.
    let received = 0;
    const limitGuard = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        received += chunk.length;
        if (received > slackFileSizeLimit) {
          callback(
            new SlackFileDownloadError(
              `${description} exceeded the download size limit mid-stream`,
              `it is larger than the ${Math.round(slackFileSizeLimit / (1_024 * 1_024))} MB download limit`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(response.body),
      limitGuard,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    return target;
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
}

function isSlackFileHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    // The bot token rides in the Authorization header; never send it over
    // plaintext, even to a Slack hostname.
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname;
    return (
      hostname === "slack.com" ||
      hostname.endsWith(".slack.com") ||
      hostname.endsWith(".slack-edge.com") ||
      hostname.endsWith(".slack-files.com")
    );
  } catch {
    return false;
  }
}

function safeName(suggestedName: string, url: string): string {
  const suggested = basename(suggestedName).replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const urlPath = new URL(url).pathname;
  const fallbackExtension = extname(urlPath).replaceAll(/[^A-Za-z0-9.]/g, "");
  const name =
    suggested.length === 0 || suggested === "." || suggested === ".." ? "attachment" : suggested;
  const withExtension =
    extname(name).length === 0 && fallbackExtension.length > 0
      ? `${name}${fallbackExtension}`
      : name;
  return withExtension.slice(-120);
}
