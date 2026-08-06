import { describe, expect, it } from "bun:test";
import {
  escapeSlackEntities,
  markdownToMrkdwn,
  mrkdwnToPlainText,
} from "../src/channels/slack/format.js";

describe("markdownToMrkdwn", () => {
  it("converts bold and italic to Slack's dialect", () => {
    expect(markdownToMrkdwn("**bold** and *italic* and __also bold__")).toBe(
      "*bold* and _italic_ and *also bold*",
    );
  });

  it("keeps plain text with single letters intact", () => {
    expect(markdownToMrkdwn("A B C /B and a*b multiplication")).toBe(
      "A B C /B and a*b multiplication",
    );
  });

  it("turns headings into bold lines", () => {
    expect(markdownToMrkdwn("# Title\n\n## Sub **section**\n\nBody")).toBe(
      "*Title*\n\n*Sub section*\n\nBody",
    );
  });

  it("renders local path links as inline code instead of broken links", () => {
    expect(markdownToMrkdwn("see [code](/data/workspace/app/src/main.ts:42) here")).toBe(
      "see code (`/data/workspace/app/src/main.ts:42`) here",
    );
    expect(markdownToMrkdwn("[](src/local/file.tsx:7)")).toBe("`src/local/file.tsx:7`");
  });

  it("rewrites links and images", () => {
    expect(markdownToMrkdwn("See [the docs](https://example.com/a) now")).toBe(
      "See <https://example.com/a|the docs> now",
    );
    expect(markdownToMrkdwn("![diagram](https://example.com/i.png)")).toBe(
      "<https://example.com/i.png|diagram>",
    );
    expect(markdownToMrkdwn("[](https://example.com)")).toBe("<https://example.com>");
  });

  it("escapes Slack entities outside and inside code", () => {
    expect(markdownToMrkdwn("1 < 2 & 3 > 2")).toBe("1 &lt; 2 &amp; 3 &gt; 2");
    expect(markdownToMrkdwn("`a < b`")).toBe("`a &lt; b`");
  });

  it("leaves fenced code untouched apart from entity escaping", () => {
    const input = "```ts\nif (a < b && c) { /* **not bold** */ }\n```";
    expect(markdownToMrkdwn(input)).toBe(
      "```ts\nif (a &lt; b &amp;&amp; c) { /* **not bold** */ }\n```",
    );
  });

  it("converts list markers and strikethrough", () => {
    expect(markdownToMrkdwn("- one\n* two\n  + three\n~~gone~~")).toBe(
      "• one\n• two\n  • three\n~gone~",
    );
  });

  it("restores blockquote markers after escaping", () => {
    expect(markdownToMrkdwn("> quoted line")).toBe("> quoted line");
  });

  it("does not treat multi-line asterisk pairs as italic", () => {
    expect(markdownToMrkdwn("2 * 3\n4 * 5")).toBe("2 * 3\n4 * 5");
  });

  it("renders markdown tables as aligned monospace blocks", () => {
    const input = "| Result | Clicks |\n|---|---:|\n| Video | 107 |\n| Audio | 30 |";
    expect(markdownToMrkdwn(input)).toBe("```\nResult  Clicks\nVideo   107\nAudio   30\n```");
  });

  it("keeps prose around tables intact", () => {
    const input = "Downloads:\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nDone **ok**";
    expect(markdownToMrkdwn(input)).toBe("Downloads:\n\n```\nA  B\n1  2\n```\n\nDone *ok*");
  });
});

describe("escapeSlackEntities", () => {
  it("escapes ampersands before angle brackets", () => {
    expect(escapeSlackEntities("&lt;")).toBe("&amp;lt;");
  });
});

describe("mrkdwnToPlainText", () => {
  it("decodes links, mentions, and entities", () => {
    expect(mrkdwnToPlainText("see <https://example.com|docs> &amp; <https://a.dev>")).toBe(
      "see docs (https://example.com) & https://a.dev",
    );
    expect(mrkdwnToPlainText("<@U123ABC> in <#C42|general> <!here>")).toBe(
      "@U123ABC in #general @here",
    );
  });
});
