import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { startTestApp, testPrincipal } from "./fixtures/web-app.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
afterEach(async () => {
  await app?.close();
});
const browserHeaders = { "X-Wirebot-Request": "1", "Content-Type": "application/json" };
async function request(path: string, init?: RequestInit) {
  return fetch(new URL(path, app.url), init);
}
async function signIn() {
  const token = await app.auth.issue(testPrincipal);
  const response = await request("/api/auth/exchange", {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  return { token, cookie: response.headers.get("set-cookie") as string };
}

describe("Browser HTTP app", () => {
  test("serves browser deep links and legacy miniapp URLs without Telegram configured", async () => {
    app = await startTestApp();
    for (const path of [
      "/",
      "/app",
      "/app/",
      "/app/settings",
      "/app/skills",
      "/app/schedules",
      "/miniapp",
      "/miniapp/",
      "/miniapp/app.js",
      "/miniapp/app.css",
    ]) {
      expect((await request(path)).status).toBe(200);
      expect((await request(path, { method: "HEAD" })).status).toBe(200);
    }
    expect((await request("/app/unknown")).status).toBe(404);
    expect((await request("/api/config")).status).toBe(401);
    expect((await request("/healthz")).status).toBe(200);
  });

  test("exchanges a link for a protected cookie, restores the session, and revokes it on logout", async () => {
    app = await startTestApp();
    const { token, cookie } = await signIn();
    expect(cookie).toContain("__Host-wirebot_session=");
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=43200"])
      expect(cookie).toContain(flag);
    const headers = { ...browserHeaders, Cookie: cookie.split(";")[0] as string };
    expect(await (await request("/api/auth/session", { headers })).json()).toEqual({
      provider: "slack",
    });
    expect((await request("/api/config", { headers })).status).toBe(200);
    expect(
      (
        await request("/api/auth/exchange", {
          method: "POST",
          headers,
          body: JSON.stringify({ token }),
        })
      ).status,
    ).toBe(401);
    const logout = await request("/api/auth/logout", { method: "POST", headers });
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await request("/api/config", { headers })).status).toBe(401);
  });

  test("rejects CSRF, simple cross-origin requests, and unauthorized users", async () => {
    app = await startTestApp();
    const { cookie } = await signIn();
    expect(
      (await request("/api/runtime/restart", { method: "POST", headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
    expect(
      (
        await request("/api/config", {
          headers: { ...browserHeaders, Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(401);
    const preflight = await request("/api/auth/exchange", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Headers": "X-Wirebot-Request",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    app.setAdmin(false);
    expect(
      (await request("/api/config", { headers: { ...browserHeaders, Cookie: cookie } })).status,
    ).toBe(403);
  });

  test("carries browser ownership and the original delivery destination into all schedule operations", async () => {
    app = await startTestApp();
    const { cookie } = await signIn();
    const headers = { ...browserHeaders, Cookie: cookie };
    await request("/api/schedules", { headers });
    await request("/api/schedules", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Test" }),
    });
    await request("/api/schedules/someone-elses-id", { method: "PATCH", headers, body: "{}" });
    await request("/api/schedules/someone-elses-id", { method: "DELETE", headers });
    expect(app.scheduleScopes.map((args) => args[0])).toEqual(Array(4).fill(testPrincipal.owner));
    expect(app.scheduleScopes[1]?.slice(0, 3)).toEqual([
      testPrincipal.owner,
      testPrincipal.conversation,
      testPrincipal.deliveryTarget,
    ]);
    const discord = {
      owner: { ...testPrincipal.owner, provider: "discord" },
      conversation: { ...testPrincipal.conversation, provider: "discord" },
      deliveryTarget: { ...testPrincipal.deliveryTarget, provider: "discord" },
    };
    const session = await app.auth.exchange(await app.auth.issue(discord));
    await request("/api/schedules", {
      headers: { ...browserHeaders, Cookie: `__Host-wirebot_session=${session}` },
    });
    expect(app.scheduleScopes.at(-1)?.[0]).toEqual(discord.owner);
  });

  test("keeps Telegram signatures, expiry, allowlists, and private schedule ownership", async () => {
    app = await startTestApp(undefined, true);
    function signed(userId: number, age = 0) {
      const data = new URLSearchParams({
        auth_date: String(Math.floor(Date.now() / 1000) - age),
        user: JSON.stringify({ id: userId }),
      });
      const secret = createHmac("sha256", "WebAppData").update("123456:TEST_BOT_TOKEN").digest();
      const signature = createHmac("sha256", secret)
        .update(
          [...data]
            .map(([key, value]) => `${key}=${value}`)
            .sort()
            .join("\n"),
        )
        .digest("hex");
      data.set("hash", signature);
      return { Authorization: `tma ${data}` };
    }
    expect((await request("/api/config", { headers: signed(42) })).status).toBe(200);
    expect((await request("/api/config", { headers: signed(43) })).status).toBe(403);
    expect((await request("/api/config", { headers: signed(42, 3601) })).status).toBe(401);
    expect(
      (await request("/api/config", { headers: { Authorization: "tma forged" } })).status,
    ).toBe(401);
    await request("/api/schedules", { headers: signed(42) });
    expect(app.scheduleScopes[0]?.[0]).toEqual({
      provider: "telegram",
      resource: "user",
      id: "42",
    });
  });
});
