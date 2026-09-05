import { describe, expect, test } from "bun:test";
import {
  type AppPrincipal,
  BrowserAuth,
  loginLifetimeMs,
  sessionLifetimeMs,
} from "../src/miniapp/browser-auth.js";

function principal(provider = "discord", id = "123"): AppPrincipal {
  return {
    owner: { provider, resource: "user", id },
    conversation: { provider, resource: "conversation", id: `${provider}:dm` },
    deliveryTarget: { provider, resource: "destination", id: "dm" },
  };
}

describe("Browser credentials", () => {
  test("links are one-use, including simultaneous exchanges", async () => {
    const auth = new BrowserAuth(() => true);
    const link = await auth.issue(principal());
    const exchanges = await Promise.allSettled([auth.exchange(link), auth.exchange(link)]);
    expect(exchanges.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(exchanges.filter((value) => value.status === "rejected")).toHaveLength(1);
    const success = exchanges.find((value) => value.status === "fulfilled");
    if (success?.status !== "fulfilled") throw new Error("No successful exchange");
    expect(success.value).not.toBe(link);
    expect(await auth.authenticate(success.value)).toEqual(principal());
    await expect(auth.authenticate(link)).rejects.toThrow();
    await expect(auth.exchange(success.value)).rejects.toThrow();
  });

  test("expires both links and sessions at their deadline", async () => {
    let now = 0;
    const auth = new BrowserAuth(
      () => true,
      () => now,
    );
    const expired = await auth.issue(principal());
    now = loginLifetimeMs;
    await expect(auth.exchange(expired)).rejects.toThrow();
    const session = await auth.exchange(await auth.issue(principal()));
    now += sessionLifetimeMs - 1;
    expect(await auth.authenticate(session)).toEqual(principal());
    now += 1;
    await expect(auth.authenticate(session)).rejects.toThrow();
  });

  test("rechecks admin permission at issuance, redemption, and on each request", async () => {
    let admin = false;
    const auth = new BrowserAuth(() => admin);
    await expect(auth.issue(principal())).rejects.toThrow("admins");
    admin = true;
    const link = await auth.issue(principal());
    const session = await auth.exchange(await auth.issue(principal("slack")));
    admin = false;
    await expect(auth.exchange(link)).rejects.toThrow("admins");
    await expect(auth.authenticate(session)).rejects.toThrow("admins");
  });

  test("replaces only the requesting admin's unused link and preserves provider scope", async () => {
    const auth = new BrowserAuth(() => true);
    const old = await auth.issue(principal());
    const slack = await auth.issue(principal("slack"));
    const fresh = await auth.issue(principal());
    await expect(auth.exchange(old)).rejects.toThrow();
    expect(await auth.authenticate(await auth.exchange(slack))).toEqual(principal("slack"));
    expect(await auth.authenticate(await auth.exchange(fresh))).toEqual(principal());
  });

  test("logout and process restarts revoke sessions", async () => {
    const auth = new BrowserAuth(() => true);
    const session = await auth.exchange(await auth.issue(principal()));
    await expect(new BrowserAuth(() => true).authenticate(session)).rejects.toThrow();
    auth.revoke(session);
    await expect(auth.authenticate(session)).rejects.toThrow();
  });

  test("rejects malformed credentials and mixed provider scopes", async () => {
    const auth = new BrowserAuth(() => true);
    for (const token of ["", "a".repeat(42), "!".repeat(43), "a".repeat(10000)]) {
      await expect(auth.exchange(token)).rejects.toThrow();
    }
    await expect(
      auth.issue({ ...principal(), deliveryTarget: principal("slack").deliveryTarget }),
    ).rejects.toThrow();
  });
});
