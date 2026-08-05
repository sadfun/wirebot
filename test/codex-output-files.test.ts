import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractMarkdownFileTargets,
  generatedFilePaths,
  resolveOutboundAttachments,
} from "../src/codex/output-files.js";
import type { ThreadItem } from "../src/generated/codex/v2/ThreadItem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("Codex outbound files", () => {
  it("extracts inline, angle-bracket, balanced-parenthesis, and reference links", () => {
    expect(
      extractMarkdownFileTargets(`[report](report.pdf)
![chart](</workspace/results/chart one.png>)
[numbered](results/report(1).pdf)
[reference][result]
[collapsed][]
[shortcut]

[result]: results/reference.pdf
[collapsed]: results/collapsed.pdf
[shortcut]: results/shortcut.pdf
[site](https://example.com)`),
    ).toEqual([
      "report.pdf",
      "/workspace/results/chart one.png",
      "results/report(1).pdf",
      "results/reference.pdf",
      "results/collapsed.pdf",
      "results/shortcut.pdf",
      "https://example.com",
    ]);
  });

  it("orders generated images before linked files, deduplicates them, and snapshots content", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(join(workspace, "results"));
    const image = join(workspace, "results", "chart one.png");
    const report = join(workspace, "results", "report.pdf");
    await writeFile(image, "image");
    await writeFile(report, "report");

    const resolution = await resolveFiles(
      workspace,
      `Files: [report](results/report.pdf) and ![chart](<${image}>)`,
      [image],
    );

    expect(resolution.attachments.map((attachment) => attachment.filename)).toEqual([
      "chart one.png",
      "report.pdf",
    ]);
    expect(
      await Promise.all(
        resolution.attachments.map(async (attachment) => await readFile(attachment.path, "utf8")),
      ),
    ).toEqual(["image", "report"]);
    expect(resolution.unavailable).toEqual([]);
  });

  it("accepts structured generated images only from the dedicated Codex directory", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    const generatedImages = join(parent, "codex-home", "generated_images");
    const staging = join(parent, "outbound", "turn");
    await mkdir(workspace);
    await mkdir(generatedImages, { recursive: true });
    const image = join(generatedImages, "generated.png");
    await writeFile(image, "generated image");

    const resolution = await resolveOutboundAttachments(workspace, generatedImages, staging, "", [
      image,
    ]);

    expect(resolution.attachments).toMatchObject([{ filename: "generated.png" }]);
    expect(await readFile(resolution.attachments[0]?.path ?? "", "utf8")).toBe("generated image");
  });

  it("does not report a structured generated image as unavailable when the answer links it", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    const generatedImages = join(parent, "codex-home", "generated_images");
    await mkdir(workspace);
    await mkdir(generatedImages, { recursive: true });
    const image = join(generatedImages, "generated.png");
    await writeFile(image, "generated image");

    const resolution = await resolveOutboundAttachments(
      workspace,
      generatedImages,
      join(parent, "outbound", "turn"),
      `![generated](<${image}>)`,
      [image],
    );

    expect(resolution.attachments).toMatchObject([{ filename: "generated.png" }]);
    expect(resolution.unavailable).toEqual([]);
  });

  it("ignores Markdown-looking paths inside code, comments, and escapes", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(join(workspace, ".env"), "secret");
    await writeFile(join(workspace, "credentials.json"), "secret");
    await writeFile(join(workspace, "escaped.pdf"), "secret");
    await writeFile(join(workspace, "report(1).pdf"), "report");
    await writeFile(join(workspace, "reference.pdf"), "reference");

    const finalText = `Inline: \`[env](.env)\`
Double: \`\`code \` [env](.env) \` code\`\`
Multiline: \`sample
[env](.env)
\`

    [env](.env)

\`\`\`md
[credentials](credentials.json)
\`\`\`\`

> \`\`\`md
> [credentials](credentials.json)
> \`\`\`

<!-- [comment](.env) -->
\\[escaped](escaped.pdf)
[not a link] (.env)
[balanced](report\\(1\\).pdf)
[reference][result]

[result]: reference.pdf
[result]: .env`;
    const resolution = await resolveFiles(workspace, finalText, []);

    expect(resolution.attachments.map((attachment) => attachment.filename)).toEqual([
      "report(1).pdf",
      "reference.pdf",
    ]);
  });

  it("rejects missing, outside, directory, line-link, and symlink escape targets visibly", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    await mkdir(workspace);
    const outside = join(parent, "private.txt");
    await writeFile(outside, "secret");
    const linkedOutside = join(workspace, "linked.txt");
    await symlink(outside, linkedOutside);
    const inside = join(workspace, "inside.txt");
    await writeFile(inside, "ok");

    const finalText = [
      `[remote](https://example.com/file.pdf)`,
      `[anchor](#result)`,
      `[outside](${outside})`,
      `[traversal](../private.txt)`,
      `[symlink](${linkedOutside})`,
      `[directory](${workspace})`,
      `[missing](missing.pdf)`,
      `[source line](${inside}:42)`,
      `raw path: \`${inside}\``,
    ].join("\n");
    const generatedImages = join(parent, "generated_images");
    await mkdir(generatedImages);
    const resolution = await resolveOutboundAttachments(
      workspace,
      generatedImages,
      join(parent, "outbound"),
      finalText,
      [outside, linkedOutside],
    );

    expect(resolution.attachments).toEqual([]);
    expect(resolution.unavailable).toEqual([
      "private.txt",
      "linked.txt",
      "workspace",
      "missing.pdf",
    ]);
  });

  it("reports the file as unavailable when a snapshot directory cannot be created", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    const generatedImages = join(parent, "generated_images");
    await mkdir(workspace);
    await mkdir(generatedImages);
    await writeFile(join(workspace, "report.pdf"), "report");
    const blockedParent = join(parent, "blocked");
    await writeFile(blockedParent, "not a directory");

    const resolution = await resolveOutboundAttachments(
      workspace,
      generatedImages,
      join(blockedParent, "turn"),
      "[report](report.pdf)",
      [],
    );

    expect(resolution).toEqual({ attachments: [], unavailable: ["report.pdf"] });
  });

  it("uploads the validated snapshot even if the source path changes afterward", async () => {
    const parent = await temporaryDirectory();
    const workspace = join(parent, "workspace");
    await mkdir(workspace);
    const source = join(workspace, "report.pdf");
    const outside = join(parent, "replacement.pdf");
    await writeFile(source, "validated");
    await writeFile(outside, "replacement");
    const resolution = await resolveFiles(workspace, "[report](report.pdf)", []);

    await rm(source);
    await symlink(outside, source);

    expect(await readFile(resolution.attachments[0]?.path ?? "", "utf8")).toBe("validated");
  });

  it("selects only image-generation items that have a saved path", () => {
    const items = [
      { type: "imageGeneration", savedPath: "/workspace/image.png" },
      { type: "imageGeneration" },
      { type: "fileChange" },
    ] as ThreadItem[];

    expect(generatedFilePaths(items)).toEqual(["/workspace/image.png"]);
  });
});

async function resolveFiles(
  workspace: string,
  finalText: string,
  generatedPaths: readonly string[],
) {
  const generatedImages = join(workspace, ".generated-images");
  const staging = join(workspace, ".staging", crypto.randomUUID());
  await mkdir(generatedImages, { recursive: true });
  return await resolveOutboundAttachments(
    workspace,
    generatedImages,
    staging,
    finalText,
    generatedPaths,
  );
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wirebot-output-"));
  temporaryDirectories.push(path);
  return path;
}
