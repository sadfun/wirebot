import { createWriteStream } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { OutboundAttachment } from "../core/channel.js";
import type { ThreadItem } from "../generated/codex/v2/ThreadItem.js";
import { isPathWithin } from "../shared/fs.js";

interface OutboundAttachmentResolution {
  readonly attachments: readonly OutboundAttachment[];
  readonly unavailable: readonly string[];
}

export function generatedFilePaths(items: readonly ThreadItem[]): readonly string[] {
  return items.flatMap((item) =>
    item.type === "imageGeneration" && item.savedPath !== undefined ? [item.savedPath] : [],
  );
}

/** Prefix the delivered text with a warning naming attachments that could not be resolved. */
export function unavailableAttachmentsWarning(
  finalText: string,
  unavailable: readonly string[],
): string {
  if (unavailable.length === 0) return finalText;
  const warning = `Could not attach ${unavailable.join(", ")}.`;
  return finalText.length === 0 ? warning : `${warning}\n\n${finalText}`;
}

function extractMarkdownFileTargets(text: string): readonly string[] {
  const targets: string[] = [];
  Bun.markdown.render(text, {
    link: (children, { href }) => {
      targets.push(unescapeMarkdownTarget(href));
      return children;
    },
    image: (children, { src }) => {
      targets.push(unescapeMarkdownTarget(src));
      return children;
    },
  });
  return targets;
}

/** Bun returns CommonMark backslash escapes verbatim in link destinations. */
function unescapeMarkdownTarget(target: string): string {
  return target.replaceAll(/\\([!-/:-@[-`{-~])/gu, "$1");
}

export async function resolveOutboundAttachments(
  workspace: string,
  generatedImagesDirectory: string,
  stagingDirectory: string,
  finalText: string,
  generatedPaths: readonly string[],
): Promise<OutboundAttachmentResolution> {
  const workspaceRoot = await canonicalDirectory(workspace);
  if (workspaceRoot === undefined) return { attachments: [], unavailable: [] };
  const generatedImagesRoot = await canonicalDirectory(generatedImagesDirectory);
  const candidates = [
    ...generatedPaths.map((target) => ({
      target,
      roots: [workspaceRoot, ...(generatedImagesRoot === undefined ? [] : [generatedImagesRoot])],
    })),
    ...extractMarkdownFileTargets(finalText).map((target) => ({
      target,
      roots: [workspaceRoot],
    })),
  ];
  if (candidates.length === 0) return { attachments: [], unavailable: [] };

  try {
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  } catch {
    return {
      attachments: [],
      unavailable: [
        ...new Set(
          candidates.flatMap(({ target }) =>
            localCandidatePath(workspaceRoot, target) === undefined
              ? []
              : [safeAttachmentName(target)],
          ),
        ),
      ],
    };
  }

  const attachments: OutboundAttachment[] = [];
  const unavailable = new Set<string>();
  const seen = new Set<string>();

  for (const { target, roots } of candidates) {
    const candidate = localCandidatePath(workspaceRoot, target);
    if (candidate === undefined) continue;
    const filename = safeAttachmentName(target);

    try {
      const canonical = await realpath(candidate);
      if (seen.has(canonical)) continue;
      if (!roots.some((root) => isPathWithin(root, canonical))) {
        unavailable.add(filename);
        continue;
      }

      const snapshot = join(
        stagingDirectory,
        `${String(attachments.length + 1).padStart(2, "0")}-${filename}`,
      );
      const attachment = await snapshotFile(canonical, snapshot, filename);
      if (attachment === undefined) {
        unavailable.add(filename);
        continue;
      }
      seen.add(canonical);
      attachments.push(attachment);
    } catch {
      unavailable.add(filename);
    }
  }

  return { attachments, unavailable: [...unavailable] };
}

/**
 * The source path is already canonicalized (realpath) and confined to an
 * allowed root by the caller; a plain open plus an fstat file-type check is
 * enough, since the only process able to race the resolved path is Codex
 * itself, which can already read these files.
 */
async function snapshotFile(
  source: string,
  destination: string,
  filename: string,
): Promise<OutboundAttachment | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(source, "r");
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) return undefined;
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    return { path: destination, filename };
  } catch {
    await rm(destination, { force: true }).catch(() => undefined);
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function localCandidatePath(workspace: string, target: string): string | undefined {
  const trimmed = target.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    trimmed.startsWith("#") ||
    /(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/i.test(trimmed)
  ) {
    return undefined;
  }
  if (!isAbsolute(trimmed) && /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return undefined;
  return isAbsolute(trimmed) ? trimmed : resolve(workspace, trimmed);
}

function safeAttachmentName(path: string): string {
  return basename(path).replace(/[\r\n]/g, "_") || "attachment";
}
