import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutboundAttachments } from "../src/codex/output-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("resolveOutboundAttachments", () => {
  it("discovers local Markdown links and images with Bun.markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "wirebot-output-files-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "out"), { recursive: true });
    await mkdir(join(workspace, "docs"), { recursive: true });
    await Promise.all([
      writeFile(join(workspace, "report.pdf"), "report"),
      writeFile(join(workspace, "out", "chart.png"), "chart"),
      writeFile(join(workspace, "docs", "a(1).pdf"), "escaped"),
    ]);

    const resolution = await resolveOutboundAttachments(
      workspace,
      join(root, "generated"),
      join(root, "staging"),
      [
        "[report](report.pdf)",
        "![plot](out/chart.png)",
        "[escaped](docs/a\\(1\\).pdf)",
        "[remote](https://example.com/file.txt)",
      ].join("\n"),
      [],
    );

    expect(resolution.attachments.map(({ filename }) => filename)).toEqual([
      "report.pdf",
      "chart.png",
      "a(1).pdf",
    ]);
    expect(resolution.unavailable).toEqual([]);
  });
});
