import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError, z } from "zod";
import {
  type CodexConfigService,
  ConfigValidationError,
  type ConfigValidationIssue,
} from "../codex/config-service.js";
import { CodexRpcError } from "../codex/rpc.js";
import type { CodexRuntimeService } from "../codex/runtime-service.js";
import { SkillBrowserError } from "../codex/skill-browser.js";
import type { WirebotSettingsStore } from "../core/settings-store.js";
import { BridgeError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { validateTelegramInitData } from "./auth.js";

const MAX_REQUEST_BYTES = 32 * 1_024;
const DEFAULT_MAX_AUTH_AGE_SECONDS = 60 * 60;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const settingsUpdateSchema = z.strictObject({
  expectedVersion: z.string().nullable(),
  values: z.record(z.string(), z.unknown()),
  wirebot: z
    .strictObject({
      remoteClientContext: z.boolean(),
    })
    .optional(),
});

const applyBankedResetSchema = z.strictObject({
  creditId: z.string().min(1).max(512),
  idempotencyKey: z.string().min(1).max(128),
});

export interface MiniAppServerOptions {
  readonly host: string;
  readonly port: number;
  readonly botToken: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly configService: CodexConfigService;
  readonly runtime: MiniAppRuntimeController;
  readonly settings: WirebotSettingsStore;
  readonly logger: Logger;
  readonly assetDirectory?: string;
}

/** Narrow runtime surface exposed to the authenticated settings Mini App. */
export type MiniAppRuntimeController = Pick<
  CodexRuntimeService,
  | "status"
  | "usageLimits"
  | "applyBankedReset"
  | "skills"
  | "browseSkill"
  | "afterConfigWrite"
  | "reload"
  | "restart"
>;

export class MiniAppServer {
  private readonly options: MiniAppServerOptions;
  readonly #server: Server;
  readonly #assetDirectory: string;
  #started = false;

  public constructor(options: MiniAppServerOptions) {
    this.options = options;
    this.#assetDirectory =
      options.assetDirectory ??
      fileURLToPath(new URL("../../dist/miniapp/public", import.meta.url));
    this.#server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.logger.error("Mini App request failed", error, {
          method: request.method,
          path: request.url,
        });
        if (!response.headersSent) this.handleError(response, error);
        else response.destroy();
      });
    });
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    await Promise.all([
      access(join(this.#assetDirectory, "index.html")),
      access(join(this.#assetDirectory, "app.js")),
      access(join(this.#assetDirectory, "app.css")),
    ]);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.options.port, this.options.host);
    });
    this.#started = true;
    this.options.logger.info("Mini App HTTP server listening", {
      host: this.options.host,
      port: this.options.port,
    });
  }

  public async stop(): Promise<void> {
    if (!this.#started) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    this.#started = false;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/healthz") {
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/config/validate") {
      this.authenticate(request);
      if (request.method === "POST") {
        const input = await this.readJson(request);
        this.sendJson(response, 200, await this.options.configService.validate(input));
        return;
      }
      response.setHeader("Allow", "POST");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/config") {
      this.authenticate(request);
      if (request.method === "GET") {
        const snapshot = await this.options.configService.read();
        this.sendJson(response, 200, {
          ...snapshot,
          wirebot: this.options.settings.read(),
          runtime: this.options.runtime.status(),
        });
        return;
      }
      if (request.method === "PUT") {
        const { expectedVersion, values, wirebot } = settingsUpdateSchema.parse(
          await this.readJson(request),
        );
        const writeOutcome =
          Object.keys(values).length === 0
            ? undefined
            : await this.options.configService.update({ expectedVersion, values });
        if (wirebot !== undefined) await this.options.settings.update(wirebot);
        if (writeOutcome !== undefined) {
          try {
            await this.options.runtime.afterConfigWrite();
          } catch (error) {
            // The version-checked config write has already committed. Preserve that
            // success and surface the runtime's degraded state in the response.
            this.options.logger.warn("Codex resources did not fully refresh after config save", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const snapshot = await this.options.configService.read();
        this.sendJson(response, 200, {
          ...snapshot,
          ...(writeOutcome === undefined ? {} : { writeOutcome }),
          wirebot: this.options.settings.read(),
          runtime: this.options.runtime.status(),
        });
        return;
      }
      response.setHeader("Allow", "GET, PUT");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/skills") {
      this.authenticate(request);
      if (request.method === "GET") {
        this.sendJson(response, 200, { skills: this.options.runtime.skills() });
        return;
      }
      response.setHeader("Allow", "GET");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/usage") {
      this.authenticate(request);
      if (request.method === "GET") {
        this.sendJson(response, 200, await this.options.runtime.usageLimits());
        return;
      }
      response.setHeader("Allow", "GET");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/usage/reset") {
      this.authenticate(request);
      if (request.method === "POST") {
        const input = applyBankedResetSchema.parse(await this.readJson(request));
        const outcome = await this.options.runtime.applyBankedReset(
          input.creditId,
          input.idempotencyKey,
        );
        this.sendJson(response, 200, { outcome });
        return;
      }
      response.setHeader("Allow", "POST");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/skills/resource") {
      this.authenticate(request);
      if (request.method === "GET") {
        const skill = url.searchParams.get("skill");
        if (skill === null || skill.length === 0) {
          throw new HttpError(400, "A skill name is required.");
        }
        const path = url.searchParams.get("path") ?? "";
        this.sendJson(response, 200, await this.options.runtime.browseSkill(skill, path));
        return;
      }
      response.setHeader("Allow", "GET");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/api/runtime/reload" || url.pathname === "/api/runtime/restart") {
      this.authenticate(request);
      if (request.method === "POST") {
        if (url.pathname.endsWith("/reload")) await this.options.runtime.reload();
        else await this.options.runtime.restart();
        this.sendJson(response, 200, { runtime: this.options.runtime.status() });
        return;
      }
      response.setHeader("Allow", "POST");
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      this.sendError(response, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/miniapp" || url.pathname === "/miniapp/") {
      await this.sendAsset(response, request.method, "index.html", "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/miniapp/app.js") {
      await this.sendAsset(response, request.method, "app.js", "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/miniapp/app.css") {
      await this.sendAsset(response, request.method, "app.css", "text/css; charset=utf-8");
      return;
    }

    this.sendError(response, 404, "Not found");
  }

  private authenticate(request: IncomingMessage): void {
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.toLowerCase().startsWith("tma ")) {
      throw new BridgeError("Telegram authorization is required", "MINIAPP_UNAUTHORIZED");
    }
    validateTelegramInitData(authorization.slice(4), {
      botToken: this.options.botToken,
      allowedUserIds: this.options.allowedUserIds,
      maxAgeSeconds: DEFAULT_MAX_AUTH_AGE_SECONDS,
    });
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }

  private async sendAsset(
    response: ServerResponse,
    method: string,
    name: "index.html" | "app.js" | "app.css",
    contentType: string,
  ): Promise<void> {
    const path = join(this.#assetDirectory, name);
    const contents = await readFile(path);
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": String(contents.byteLength),
      "Content-Type": contentType,
    });
    if (method === "HEAD") response.end();
    else response.end(contents);
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      "Content-Length": String(body.byteLength),
      "Content-Type": JSON_CONTENT_TYPE,
    });
    response.end(body);
  }

  private sendError(response: ServerResponse, status: number, message: string): void {
    this.sendJson(response, status, { error: message });
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (error instanceof HttpError) {
      this.sendError(response, error.status, error.message);
      return;
    }
    if (error instanceof SkillBrowserError) {
      const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 413;
      this.sendError(response, status, error.message);
      return;
    }
    if (error instanceof ZodError) {
      this.sendJson(response, 400, {
        error: "Invalid config update",
        issues: normalizeZodIssues(error),
      });
      return;
    }
    if (error instanceof ConfigValidationError) {
      this.sendJson(response, 422, {
        error: error.message,
        issues: error.issues,
      });
      return;
    }
    if (error instanceof CodexRpcError) {
      const code = configWriteErrorCode(error.data);
      if (code === "configLayerReadonly") {
        this.sendError(response, 403, error.message);
        return;
      }
      if (code === "configValidationError") {
        this.sendError(response, 422, error.message);
        return;
      }
      this.sendError(response, code === "configVersionConflict" ? 409 : 502, error.message);
      return;
    }
    if (error instanceof BridgeError) {
      if (error.code === "MINIAPP_UNAUTHORIZED") {
        response.setHeader("WWW-Authenticate", "tma");
        this.sendError(response, 401, error.message);
        return;
      }
      if (error.code === "MINIAPP_FORBIDDEN") {
        this.sendError(response, 403, error.message);
        return;
      }
      if (error.code === "SKILL_NOT_FOUND") {
        this.sendError(response, 404, error.message);
        return;
      }
    }
    this.sendError(response, 500, "Internal server error");
  }
}

function normalizeZodIssues(error: ZodError): ConfigValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    severity: "error",
    message: issue.message,
  }));
}

function configWriteErrorCode(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const code = (data as Record<string, unknown>).config_write_error_code;
  return typeof code === "string" ? code : undefined;
}

class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}
