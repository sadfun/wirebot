import { expect, test } from "bun:test";
import { startTestApp, testPrincipal } from "./fixtures/web-app.js";

test("messages use the existing session's conversation and cannot override routing", async () => {
  const app = await startTestApp();
  const received: unknown[] = [];
  app.server.setMessageHandler(async (scope, message) => {
    received.push({ scope, message });
  });
  try {
    const token = await app.auth.exchange(await app.auth.issue(testPrincipal));
    const post = async (body: unknown, credential = token) =>
      await fetch(new URL("/api/messages", app.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ message: "Check the work" }, "invalid")).status).toBe(401);
    expect((await post({ message: "Check the work", conversation: "someone-else" })).status).toBe(
      400,
    );
    expect((await post({ message: " " })).status).toBe(400);
    const response = await post({ message: "Check the work" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(received).toEqual([{ scope: testPrincipal, message: "Check the work" }]);
    app.setAdmin(false);
    expect((await post({ message: "Revoked" })).status).toBe(403);
    app.setAdmin(true);
    app.auth.revoke(token);
    expect((await post({ message: "Logged out" })).status).toBe(401);
    expect(received).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("messages retain cookie CSRF checks and reject missing handlers and invalid methods", async () => {
  const app = await startTestApp();
  try {
    const response = await fetch(new URL("/api/auth/exchange", app.url), {
      method: "POST",
      headers: { "X-Wirebot-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ token: await app.auth.issue(testPrincipal) }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    const headers: Record<string, string> = { Cookie: cookie, "Content-Type": "application/json" };
    expect(
      (
        await fetch(new URL("/api/messages", app.url), {
          method: "POST",
          headers,
          body: JSON.stringify({ message: "test" }),
        })
      ).status,
    ).toBe(401);
    headers["X-Wirebot-Request"] = "1";
    expect(
      (
        await fetch(new URL("/api/messages", app.url), {
          method: "POST",
          headers,
          body: JSON.stringify({ message: "test" }),
        })
      ).status,
    ).toBe(503);
    expect((await fetch(new URL("/api/messages", app.url), { headers })).status).toBe(405);
  } finally {
    await app.close();
  }
});
