import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type CodexConfigService, ConfigValidationError } from "../src/codex/config-service.js";
import type {
  ApplyBankedResetOutcome,
  CodexRuntimeStatus,
  CodexUsageLimits,
} from "../src/codex/runtime-service.js";
import type { SkillResource } from "../src/codex/skill-browser.js";
import type { WirebotSettings, WirebotSettingsStore } from "../src/core/settings-store.js";
import type { ConfigWriteResponse } from "../src/generated/codex/v2/ConfigWriteResponse.js";
import type { MiniAppRuntimeController } from "../src/miniapp/server.js";
import { MiniAppServer } from "../src/miniapp/server.js";
import type { Logger } from "../src/shared/logger.js";

const botToken = "123456:abcdefghijklmnopqrstuvwxyzABCDE";

const readyStatus: CodexRuntimeStatus = {
  state: "ready",
  restartRequired: false,
  lastError: null,
  lastAppliedAt: null,
  configPath: null,
};

describe("MiniAppServer config API", () => {
  it("returns the fresh snapshot with the generated write outcome", async () => {
    const snapshot = {
      version: "revision-2",
      values: { model: "gpt-test" },
      capabilities: { models: [] },
      validation: { valid: true, issues: [] },
    };
    const writeOutcome: ConfigWriteResponse = {
      status: "okOverridden",
      version: "revision-2",
      filePath: "/tmp/codex/config.toml",
      overriddenMetadata: {
        message: "A project layer overrides this value.",
        overridingLayer: {
          name: { type: "project", dotCodexFolder: "/workspace/.codex" },
          version: "project-revision",
        },
        effectiveValue: "gpt-managed",
      },
    };
    const update = vi.fn(async (_input: unknown) => writeOutcome);
    const read = vi.fn(async () => snapshot);
    const runtime = testRuntime();
    const server = testServer(
      {
        update,
        read,
        validate: vi.fn(async () => ({ valid: true, issues: [] })),
      },
      testSettingsStore(),
      runtime,
    );

    const response = await dispatch(
      server,
      request("PUT", "/api/config", {
        expectedVersion: "revision-1",
        values: { model: "gpt-test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({
      ...snapshot,
      writeOutcome,
      wirebot: { remoteClientContext: true },
      runtime: readyStatus,
    });
    expect(update).toHaveBeenCalledWith({
      expectedVersion: "revision-1",
      values: { model: "gpt-test" },
    });
    expect(read).toHaveBeenCalledOnce();
    expect(runtime.afterConfigWrite).toHaveBeenCalledOnce();
  });

  it("updates Wirebot settings without rewriting Codex config", async () => {
    const snapshot = {
      version: "revision-1",
      values: { model: "gpt-test" },
      capabilities: { models: [] },
      validation: { valid: true, issues: [] },
    };
    const update = vi.fn();
    const settings = testSettingsStore();
    const server = testServer(
      {
        update,
        read: vi.fn(async () => snapshot),
        validate: vi.fn(),
      },
      settings,
    );

    const response = await dispatch(
      server,
      request("PUT", "/api/config", {
        expectedVersion: "revision-1",
        values: {},
        wirebot: { remoteClientContext: false },
      }),
    );

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({
      ...snapshot,
      wirebot: { remoteClientContext: false },
      runtime: readyStatus,
    });
    expect(update).not.toHaveBeenCalled();
    expect(settings.update).toHaveBeenCalledWith({ remoteClientContext: false });
  });

  it.each([
    ["reload", "reload"],
    ["restart", "restart"],
  ] as const)("runs the authenticated runtime %s action", async (path, method) => {
    const runtime = testRuntime();
    const server = testServer(
      { update: vi.fn(), read: vi.fn(), validate: vi.fn() },
      testSettingsStore(),
      runtime,
    );

    const response = await dispatch(server, request("POST", `/api/runtime/${path}`, undefined));

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({ runtime: readyStatus });
    expect(runtime[method]).toHaveBeenCalledOnce();
  });

  it("lists Codex skills and serves an authenticated skill resource", async () => {
    const runtime = testRuntime();
    const server = testServer(
      { update: vi.fn(), read: vi.fn(), validate: vi.fn() },
      testSettingsStore(),
      runtime,
    );

    const skillsResponse = await dispatch(server, request("GET", "/api/skills", undefined));
    const resourceResponse = await dispatch(
      server,
      request(
        "GET",
        "/api/skills/resource?skill=github%3Ayeet&path=references%2Frelease.md",
        undefined,
      ),
    );

    expect(skillsResponse.status).toBe(200);
    expect(responseJson(skillsResponse)).toEqual({
      skills: [{ name: "github:yeet", description: "Publish changes" }],
    });
    expect(resourceResponse.status).toBe(200);
    expect(responseJson(resourceResponse)).toEqual({
      type: "file",
      path: "references/release.md",
      size: 7,
      mediaType: "text/markdown",
      encoding: "utf8",
      content: "Release",
    });
    expect(runtime.browseSkill).toHaveBeenCalledWith("github:yeet", "references/release.md");
  });

  it("returns authenticated Codex usage limits", async () => {
    const runtime = testRuntime();
    const server = testServer(
      { update: vi.fn(), read: vi.fn(), validate: vi.fn() },
      testSettingsStore(),
      runtime,
    );

    const response = await dispatch(server, request("GET", "/api/usage", undefined));

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({
      weekly: { remainingPercent: 68, resetsAt: 1_800_000_000 },
      fiveHour: null,
      bankedResets: {
        availableCount: 1,
        credits: [
          {
            id: "reset-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: 1_799_000_000,
            expiresAt: 1_801_000_000,
            title: "Usage reset",
            description: null,
          },
        ],
      },
    });
    expect(runtime.usageLimits).toHaveBeenCalledOnce();
  });

  it("applies an authenticated banked reset with an idempotency key", async () => {
    const runtime = testRuntime();
    const server = testServer(
      { update: vi.fn(), read: vi.fn(), validate: vi.fn() },
      testSettingsStore(),
      runtime,
    );

    const response = await dispatch(
      server,
      request("POST", "/api/usage/reset", { creditId: "reset-1", idempotencyKey: "attempt-1" }),
    );

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({ outcome: "reset" });
    expect(runtime.applyBankedReset).toHaveBeenCalledWith("reset-1", "attempt-1");
  });

  it("serves the compiled Mini App stylesheet", async () => {
    const assetDirectory = await mkdtemp(join(tmpdir(), "wirebot-miniapp-assets-"));
    try {
      await Promise.all([
        writeFile(join(assetDirectory, "index.html"), "<!doctype html>"),
        writeFile(join(assetDirectory, "app.js"), "export {};"),
        writeFile(join(assetDirectory, "app.css"), ":root{color-scheme:light dark}"),
      ]);
      const server = testServer(
        { update: vi.fn(), read: vi.fn(), validate: vi.fn() },
        testSettingsStore(),
        testRuntime(),
        assetDirectory,
      );

      const response = await dispatch(server, request("GET", "/miniapp/app.css", undefined));
      const htmlResponse = await dispatch(server, request("GET", "/miniapp", undefined));

      expect(response.status).toBe(200);
      expect(response.body?.toString("utf8")).toBe(":root{color-scheme:light dark}");
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get("content-security-policy")).toContain(
        "style-src 'self' 'unsafe-inline'",
      );
    } finally {
      await rm(assetDirectory, { recursive: true, force: true });
    }
  });

  it("normalizes Zod request failures for inline field display", async () => {
    const requestSchema = z.strictObject({
      expectedVersion: z.string(),
      values: z.strictObject({ model: z.string().max(3) }),
    });
    const server = testServer({
      update: vi.fn(),
      read: vi.fn(),
      validate: async (input: unknown) => requestSchema.parse(input),
    });

    const response = await dispatch(
      server,
      request("POST", "/api/config/validate", {
        expectedVersion: "revision-1",
        values: { model: "too-long" },
      }),
    );
    const body = responseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid config update" });
    expect((body as { issues: unknown }).issues).toEqual([
      {
        path: "values.model",
        severity: "error",
        message: expect.any(String),
      },
    ]);
  });

  it("keeps semantic validation failures in the same structured issue shape", async () => {
    const issues = [
      {
        path: "model_reasoning_effort",
        severity: "error" as const,
        message: "The selected model does not support this effort.",
      },
    ];
    const server = testServer({
      update: vi.fn(),
      read: vi.fn(),
      validate: async () => {
        throw new ConfigValidationError(issues);
      },
    });

    const response = await dispatch(
      server,
      request("POST", "/api/config/validate", {
        expectedVersion: "revision-1",
        values: { model: "gpt-test" },
      }),
    );

    expect(response.status).toBe(422);
    expect(responseJson(response)).toEqual({
      error: "The config update is invalid",
      issues,
    });
  });
});

interface TestConfigService {
  readonly read: () => Promise<unknown>;
  readonly update: (input: unknown) => Promise<unknown>;
  readonly validate: (input: unknown) => Promise<unknown>;
}

interface TestableMiniAppServer {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly handleError: (response: ServerResponse, error: unknown) => void;
}

interface CapturedResponse {
  readonly response: ServerResponse;
  readonly headers: Map<string, unknown>;
  status: number | undefined;
  body: Buffer | undefined;
}

function testServer(
  configService: TestConfigService,
  settings: TestSettingsStore = testSettingsStore(),
  runtime: TestRuntimeController = testRuntime(),
  assetDirectory?: string,
): MiniAppServer {
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
  } as unknown as Logger;
  return new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    botToken,
    allowedUserIds: new Set([42]),
    configService: configService as unknown as CodexConfigService,
    runtime,
    settings: settings as unknown as WirebotSettingsStore,
    logger,
    ...(assetDirectory === undefined ? {} : { assetDirectory }),
  });
}

interface TestRuntimeController extends MiniAppRuntimeController {
  readonly usageLimits: ReturnType<typeof vi.fn<() => Promise<CodexUsageLimits>>>;
  readonly applyBankedReset: ReturnType<
    typeof vi.fn<(creditId: string, idempotencyKey: string) => Promise<ApplyBankedResetOutcome>>
  >;
  readonly browseSkill: ReturnType<
    typeof vi.fn<(name: string, path: string) => Promise<SkillResource>>
  >;
  readonly afterConfigWrite: ReturnType<typeof vi.fn<() => Promise<CodexRuntimeStatus>>>;
  readonly reload: ReturnType<typeof vi.fn<() => Promise<CodexRuntimeStatus>>>;
  readonly restart: ReturnType<typeof vi.fn<() => Promise<CodexRuntimeStatus>>>;
}

function testRuntime(): TestRuntimeController {
  return {
    status: () => readyStatus,
    usageLimits: vi.fn(async () => ({
      weekly: { remainingPercent: 68, resetsAt: 1_800_000_000 },
      fiveHour: null,
      bankedResets: {
        availableCount: 1,
        credits: [
          {
            id: "reset-1",
            resetType: "codexRateLimits" as const,
            status: "available" as const,
            grantedAt: 1_799_000_000,
            expiresAt: 1_801_000_000,
            title: "Usage reset",
            description: null,
          },
        ],
      },
    })),
    applyBankedReset: vi.fn(async () => "reset" as const),
    skills: () => [{ name: "github:yeet", description: "Publish changes" }],
    browseSkill: vi.fn(async () => ({
      type: "file" as const,
      path: "references/release.md",
      size: 7,
      mediaType: "text/markdown",
      encoding: "utf8" as const,
      content: "Release",
    })),
    afterConfigWrite: vi.fn(async () => readyStatus),
    reload: vi.fn(async () => readyStatus),
    restart: vi.fn(async () => readyStatus),
  };
}

interface TestSettingsStore {
  readonly read: () => WirebotSettings;
  readonly update: ReturnType<typeof vi.fn<(input: unknown) => Promise<WirebotSettings>>>;
}

function testSettingsStore(): TestSettingsStore {
  let settings: WirebotSettings = { remoteClientContext: true };
  return {
    read: () => settings,
    update: vi.fn(async (input: unknown) => {
      settings = input as WirebotSettings;
      return settings;
    }),
  };
}

async function dispatch(
  server: MiniAppServer,
  request: IncomingMessage,
): Promise<CapturedResponse> {
  const captured = captureResponse();
  const testable = server as unknown as TestableMiniAppServer;
  try {
    await testable.handle(request, captured.response);
  } catch (error) {
    testable.handleError(captured.response, error);
  }
  return captured;
}

function request(method: string, url: string, body: unknown): IncomingMessage {
  const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: {
      authorization: `tma ${signedInitData()}`,
      "content-type": "application/json",
    },
    [Symbol.asyncIterator]: async function* () {
      yield encoded;
    },
  } as unknown as IncomingMessage;
}

function captureResponse(): CapturedResponse {
  const headers = new Map<string, unknown>();
  const captured = {
    headers,
    status: undefined,
    body: undefined,
  } as CapturedResponse;
  const response = {
    headersSent: false,
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    writeHead(status: number, values?: Readonly<Record<string, unknown>>) {
      captured.status = status;
      for (const [name, value] of Object.entries(values ?? {})) {
        headers.set(name.toLowerCase(), value);
      }
      response.headersSent = true;
      return response;
    },
    end(body?: Uint8Array) {
      captured.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
      return response;
    },
    destroy: vi.fn(),
  };
  Object.assign(captured, { response: response as unknown as ServerResponse });
  return captured;
}

function responseJson(response: CapturedResponse): Readonly<Record<string, unknown>> {
  if (response.body === undefined) throw new Error("Mini App response body is missing");
  return JSON.parse(response.body.toString("utf8")) as Readonly<Record<string, unknown>>;
}

function signedInitData(): string {
  const fields = new Map<string, string>([
    ["auth_date", String(Math.floor(Date.now() / 1_000))],
    ["query_id", "AAEAAAE"],
    ["user", JSON.stringify({ id: 42, first_name: "Ada" })],
  ]);
  const dataCheckString = [...fields.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams([...fields, ["hash", hash]]).toString();
}
