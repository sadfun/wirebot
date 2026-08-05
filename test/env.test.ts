import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/env.js";

const required = {
  TELEGRAM_BOT_TOKEN: "12345678901234567890:token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 9001",
};

describe("loadAppConfig", () => {
  it("parses allowlisted users and safe defaults", () => {
    const config = loadAppConfig(required);
    expect([...config.allowedUserIds]).toEqual([42, 9001]);
    expect(config.telegramApiBase).toBe("https://api.telegram.org");
    expect(config.host).toBe("127.0.0.1");
    expect(config.tunnelMode).toBe("auto");
  });

  it("disables the quick tunnel with WIREBOT_TUNNEL=off", () => {
    expect(loadAppConfig({ ...required, WIREBOT_TUNNEL: "off" }).tunnelMode).toBe("off");
  });

  it("rejects malformed allowlist entries", () => {
    expect(() =>
      loadAppConfig({
        ...required,
        TELEGRAM_ALLOWED_USER_IDS: "42,not-a-user",
      }),
    ).toThrow();
  });
});
