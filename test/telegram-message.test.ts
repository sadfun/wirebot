import type { Message, PhotoSize, Sticker } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  isTelegramTopicLifecycleMessage,
  normalizeTelegramMessage,
} from "../src/channels/telegram/message.js";

const smallPhoto: PhotoSize = {
  file_id: "small-file",
  file_unique_id: "small",
  width: 100,
  height: 100,
  file_size: 1_000,
};
const largePhoto: PhotoSize = {
  file_id: "large-file",
  file_unique_id: "large",
  width: 1_000,
  height: 800,
  file_size: 20_000,
};

describe("normalizeTelegramMessage", () => {
  it("keeps a photo caption and selects only the largest photo", () => {
    const result = normalizeTelegramMessage(
      message({
        caption: "What is happening here?",
        photo: [smallPhoto, largePhoto],
      }),
    );

    expect(result.text).toContain("What is happening here?");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      fileId: "large-file",
      uniqueId: "large",
      nativeImage: true,
      mimeType: "image/jpeg",
    });
  });

  it("marks Telegram voice messages for transcription", () => {
    const result = normalizeTelegramMessage(
      message({
        voice: {
          file_id: "voice-file",
          file_unique_id: "voice",
          duration: 4,
          mime_type: "audio/ogg",
        },
      }),
    );

    expect(result.text).toBe("[Voice message]");
    expect(result.files[0]).toMatchObject({
      suggestedName: "voice.ogg",
      mimeType: "audio/ogg",
      voiceMessage: true,
    });
  });

  it.each([
    ["static", false, false, ".webp", true],
    ["animated", true, false, ".tgs", false],
    ["video", false, true, ".webm", false],
  ] as const)("normalizes %s stickers", (_format, isAnimated, isVideo, extension, nativeImage) => {
    const result = normalizeTelegramMessage(
      message({
        sticker: sticker({ is_animated: isAnimated, is_video: isVideo }),
      }),
    );

    expect(result.text).toContain("Sticker 😀");
    expect(result.files[0]?.suggestedName.endsWith(extension)).toBe(true);
    expect(result.files[0]?.nativeImage).toBe(nativeImage);
  });

  it("includes replied-to text and image with reply context", () => {
    const result = normalizeTelegramMessage(
      message({
        text: "Please use this",
        reply_to_message: message({
          from: { id: 2, is_bot: false, first_name: "Grace" },
          caption: "Original diagram",
          photo: [largePhoto],
        }) as Message & { reply_to_message: undefined },
      }),
    );

    expect(result.text).toContain("Replying to Grace");
    expect(result.text).toContain("Original diagram");
    expect(result.text).toContain("Please use this");
    expect(result.files[0]?.description).toContain("Replied-to");
  });

  it("omits Telegram's implicit topic-root reply context from commands", () => {
    const result = normalizeTelegramMessage(
      message({
        text: "/start",
        message_thread_id: 17,
        is_topic_message: true,
        reply_to_message: message({
          from: { id: 2, is_bot: false, first_name: "Ada" },
          forum_topic_created: { name: "Work", icon_color: 7_322_096 },
        }) as Message & { reply_to_message: undefined },
      }),
    );

    expect(result).toEqual({ text: "/start", files: [] });
  });

  it("includes guest reference messages and their attachments", () => {
    const result = normalizeTelegramMessage(
      message({ text: "@wirebot_bot What does this mean?" }),
      [
        message({
          message_id: 41,
          from: { id: 2, is_bot: false, first_name: "Grace" },
          caption: "Original diagram",
          photo: [largePhoto],
        }),
      ],
    );

    expect(result.text).toContain("Referenced message from Grace:");
    expect(result.text).toContain("Original diagram");
    expect(result.text).toContain("@wirebot_bot What does this mean?");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.description).toContain("Referenced Telegram photo");
  });

  it("includes forward origin metadata", () => {
    const result = normalizeTelegramMessage(
      message({
        text: "Forwarded content",
        forward_origin: {
          type: "hidden_user",
          date: 1_700_000_000,
          sender_user_name: "Ada Lovelace",
        },
      }),
    );

    expect(result.text).toContain("Forwarded from Ada Lovelace (hidden user)");
    expect(result.text).toContain("Forwarded content");
  });

  it("renders polls with options, counts, and correct answers", () => {
    const result = normalizeTelegramMessage(
      message({
        poll: {
          id: "poll-1",
          question: "Ship it?",
          options: [
            { persistent_id: "yes", text: "Yes", voter_count: 3 },
            { persistent_id: "no", text: "No", voter_count: 1 },
          ],
          total_voter_count: 4,
          is_closed: false,
          is_anonymous: true,
          type: "quiz",
          allows_multiple_answers: false,
          allows_revoting: false,
          members_only: false,
          correct_option_ids: [0],
        },
      }),
    );

    expect(result.text).toContain("Poll: Ship it? (quiz, open, 4 votes)");
    expect(result.text).toContain("Yes — 3 votes [correct]");
    expect(result.text).toContain("No — 1 votes");
  });

  it("does not drop zero-valued location details", () => {
    const result = normalizeTelegramMessage(
      message({
        location: {
          latitude: 0,
          longitude: 0,
          horizontal_accuracy: 0,
          live_period: 0,
          heading: 0,
          proximity_alert_radius: 0,
        },
      }),
    );

    expect(result.text).toContain("Location: 0, 0");
    expect(result.text).toContain("accuracy 0 m");
    expect(result.text).toContain("live 0 s");
    expect(result.text).toContain("heading 0°");
    expect(result.text).toContain("proximity 0 m");
  });

  it("uses a bounded generic remainder and redacts Passport data", () => {
    const result = normalizeTelegramMessage(
      message({
        new_chat_title: "A new title",
        giveaway: { prize_description: "x".repeat(500) } as unknown as NonNullable<
          Message["giveaway"]
        >,
        passport_data: { secret: "must-not-leak" } as unknown as NonNullable<
          Message["passport_data"]
        >,
      }),
    );

    expect(result.text).toContain('New chat title: "A new title".');
    expect(result.text).toContain("Giveaway: ");
    expect(result.text).not.toContain("x".repeat(300));
    expect(result.text).toContain("Passport data received (redacted)");
    expect(result.text).not.toContain("must-not-leak");
  });

  it("does not attach the document compatibility alias for an animation", () => {
    const result = normalizeTelegramMessage(
      message({
        animation: {
          file_id: "animation-file",
          file_unique_id: "animation",
          width: 320,
          height: 240,
          duration: 2,
          mime_type: "image/gif",
        },
        document: {
          file_id: "alias-file",
          file_unique_id: "different-alias-id",
          file_name: "alias.gif",
          mime_type: "image/gif",
        },
      }),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.uniqueId).toBe("animation");
  });

  it("sanitizes suggested document names with basename semantics", () => {
    const result = normalizeTelegramMessage(
      message({
        document: {
          file_id: "document-file",
          file_unique_id: "document",
          file_name: "../../private/report.pdf",
          mime_type: "application/pdf",
        },
      }),
    );

    expect(result.files[0]?.suggestedName).toBe("report.pdf");
  });

  it.each([
    ["empty", {}],
    ["photo", { photo: [largePhoto] }],
    ["contact", { contact: { phone_number: "0", first_name: "Nobody" } }],
    ["dice", { dice: { emoji: "🎲", value: 1 } }],
    ["story", { story: { id: 4, chat: { id: 2, type: "channel", title: "News" } } }],
    ["service", { group_chat_created: true }],
  ] as const)("never returns empty text for a %s message", (_name, content) => {
    expect(normalizeTelegramMessage(message(content as Partial<Message>)).text.trim()).not.toBe("");
  });
});

describe("isTelegramTopicLifecycleMessage", () => {
  it.each([
    { forum_topic_created: { name: "Work", icon_color: 7_322_096 } },
    { forum_topic_edited: { name: "Renamed" } },
    { forum_topic_closed: {} },
    { forum_topic_reopened: {} },
    { general_forum_topic_hidden: {} },
    { general_forum_topic_unhidden: {} },
  ] as const)("recognizes topic lifecycle service messages", (content) => {
    expect(isTelegramTopicLifecycleMessage(message(content as Partial<Message>))).toBe(true);
  });

  it("does not suppress an ordinary message replying to a lifecycle event", () => {
    expect(
      isTelegramTopicLifecycleMessage(
        message({
          text: "hello",
          reply_to_message: message({
            forum_topic_created: { name: "Work", icon_color: 7_322_096 },
          }) as Message & { reply_to_message: undefined },
        }),
      ),
    ).toBe(false);
  });
});

function message(content: Partial<Message>): Message {
  return {
    message_id: 1,
    date: 1_700_000_100,
    chat: { id: 1, type: "private", first_name: "Test" },
    ...content,
  } as Message;
}

function sticker(overrides: Partial<Sticker>): Sticker {
  return {
    file_id: "sticker-file",
    file_unique_id: `sticker-${String(overrides.is_animated)}-${String(overrides.is_video)}`,
    type: "regular",
    width: 512,
    height: 512,
    is_animated: false,
    is_video: false,
    emoji: "😀",
    set_name: "test_set",
    ...overrides,
  };
}
