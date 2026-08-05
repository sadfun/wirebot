import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillResource, SkillBrowserError } from "../src/codex/skill-browser.js";

describe("skill browser", () => {
  it("lists bundled files and reads text and image resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "wirebot-skill-browser-"));
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "# Example\n");
    await writeFile(join(root, "references", "guide.md"), "Use carefully.\n");
    await writeFile(join(root, "preview.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(readSkillResource(join(root, "SKILL.md"), "")).resolves.toEqual({
      type: "directory",
      path: "",
      entries: [
        { name: "references", path: "references", type: "directory", size: null },
        { name: "preview.png", path: "preview.png", type: "file", size: 4 },
        { name: "SKILL.md", path: "SKILL.md", type: "file", size: 10 },
      ],
    });
    await expect(
      readSkillResource(join(root, "SKILL.md"), "references/guide.md"),
    ).resolves.toMatchObject({
      type: "file",
      path: "references/guide.md",
      mediaType: "text/markdown",
      encoding: "utf8",
      content: "Use carefully.\n",
    });
    await expect(readSkillResource(join(root, "SKILL.md"), "preview.png")).resolves.toMatchObject({
      type: "file",
      mediaType: "image/png",
      encoding: "base64",
      content: "iVBORw==",
    });
  });

  it("rejects traversal and symlinks that leave the skill directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "wirebot-skill-browser-"));
    const outside = await mkdtemp(join(tmpdir(), "wirebot-skill-outside-"));
    await writeFile(join(root, "SKILL.md"), "# Example\n");
    await writeFile(join(outside, "secret.txt"), "not part of the skill");
    await symlink(join(outside, "secret.txt"), join(root, "outside.txt"));

    await expect(readSkillResource(join(root, "SKILL.md"), "../secret.txt")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(readSkillResource(join(root, "SKILL.md"), "outside.txt")).rejects.toBeInstanceOf(
      SkillBrowserError,
    );
    await expect(readSkillResource(join(root, "SKILL.md"), "")).resolves.toMatchObject({
      entries: [{ name: "SKILL.md" }],
    });
  });

  it("limits large file previews", async () => {
    const root = await mkdtemp(join(tmpdir(), "wirebot-skill-browser-"));
    await writeFile(join(root, "SKILL.md"), "# Example\n");
    await writeFile(join(root, "large.bin"), Buffer.alloc(2 * 1_024 * 1_024 + 1));

    await expect(readSkillResource(join(root, "SKILL.md"), "large.bin")).rejects.toMatchObject({
      code: "too_large",
    });
  });
});
