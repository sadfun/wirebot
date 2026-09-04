import { describe, expect, test } from "bun:test";
import { classifyCodexHealth } from "../src/miniapp/server.js";

describe("Codex health", () => {
  test("distinguishes login from configurations that need no account", () => {
    expect(classifyCodexHealth({ account: null, requiresOpenaiAuth: true })).toBe("needs_login");
    expect(classifyCodexHealth({ account: null, requiresOpenaiAuth: false })).toBe("not_required");
    expect(
      classifyCodexHealth({
        account: { type: "apiKey" },
        requiresOpenaiAuth: true,
      }),
    ).toBe("authenticated");
  });
});
