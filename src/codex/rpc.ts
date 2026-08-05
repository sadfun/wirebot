import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ClientNotification } from "../generated/codex/ClientNotification.js";
import type { ClientRequest } from "../generated/codex/ClientRequest.js";
import type { InitializeResponse } from "../generated/codex/InitializeResponse.js";
import type { RequestId } from "../generated/codex/RequestId.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { ServerRequest } from "../generated/codex/ServerRequest.js";
import type { DynamicToolSpec } from "../generated/codex/v2/DynamicToolSpec.js";
import type { ThreadStartParams } from "../generated/codex/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../generated/codex/v2/TurnStartParams.js";
import { type Deferred, deferred, delay, withTimeout } from "../shared/async.js";
import { externalProcessEnvironment } from "../shared/environment.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { type CodexLaunch, resolveCodexLaunch } from "./linux-sandbox.js";

type StableClientRequestInput = ClientRequest extends infer Request
  ? Request extends { id: RequestId }
    ? Omit<Request, "id">
    : never
  : never;

interface ApplicationContextEntry {
  readonly value: string;
  readonly kind: "application";
}

export type ApplicationContext = Readonly<Record<string, ApplicationContextEntry>>;

interface TurnStartWithAdditionalContext {
  readonly method: "turn/start";
  readonly params: TurnStartParams & {
    readonly additionalContext: ApplicationContext;
  };
}

interface ThreadStartWithDynamicTools {
  readonly method: "thread/start";
  readonly params: ThreadStartParams & {
    readonly dynamicTools: readonly DynamicToolSpec[];
  };
}

type ClientRequestInput =
  | StableClientRequestInput
  | TurnStartWithAdditionalContext
  | ThreadStartWithDynamicTools;

const wireMessageSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .loose();

interface PendingRequest {
  readonly deferred: Deferred<unknown>;
}

export class CodexRpcError extends BridgeError {
  public readonly rpcCode: number;
  public readonly data: unknown;

  public constructor(message: string, rpcCode: number, data?: unknown) {
    super(message, "CODEX_RPC_ERROR");
    this.rpcCode = rpcCode;
    this.data = data;
    this.name = "CodexRpcError";
  }
}

export type NotificationListener = (notification: ServerNotification) => void;
export type ServerRequestHandler = (request: ServerRequest) => Promise<void>;

export interface CodexAppServerExit {
  readonly error: BridgeError;
  readonly expected: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | string | null;
}

export type ExitListener = (exit: CodexAppServerExit) => void;
type CodexLaunchResolver = (
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<CodexLaunch>;

/** The app-server's transient overloaded/busy JSON-RPC code; such requests retry up to 3 times. */
const TRANSIENT_OVERLOAD_RPC_CODE = -32_001;

export class CodexAppServer {
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #exitListeners = new Set<ExitListener>();
  #serverRequestHandler: ServerRequestHandler | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #stopping = false;
  readonly #binaryPath: string;
  readonly #workspace: string;
  readonly #codexHome: string;
  readonly #clientVersion: string;
  readonly #logger: Logger;
  readonly #resolveLaunch: CodexLaunchResolver;

  public constructor(
    binaryPath: string,
    workspace: string,
    codexHome: string,
    clientVersion: string,
    logger: Logger,
    launchResolver: CodexLaunchResolver = async (path, args, cwd, env) =>
      await resolveCodexLaunch({ binaryPath: path, args, cwd, env }),
  ) {
    this.#binaryPath = binaryPath;
    this.#workspace = workspace;
    this.#codexHome = codexHome;
    this.#clientVersion = clientVersion;
    this.#logger = logger;
    this.#resolveLaunch = launchResolver;
  }

  public async start(): Promise<InitializeResponse> {
    if (this.#child !== undefined) {
      throw new BridgeError("Codex app-server is already started", "CODEX_ALREADY_STARTED");
    }
    this.#stopping = false;

    const appServerArgs = ["app-server", "--strict-config", "--listen", "stdio://"] as const;
    const environment = externalProcessEnvironment({
      CODEX_HOME: this.#codexHome,
      LOG_FORMAT: "json",
    });
    const launch = await this.#resolveLaunch(
      this.#binaryPath,
      appServerArgs,
      this.#workspace,
      environment,
    );
    if (launch.appArmorProfile !== undefined) {
      this.#logger.warn("Using an AppArmor userns compatibility profile for Codex sandboxing", {
        profile: launch.appArmorProfile,
      });
    }
    const child = spawn(launch.executable, launch.args, {
      cwd: this.#workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.#child = child;
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
    child.on("error", (error) => {
      if (this.#child !== child) return;
      if (!spawned) this.handleExit(child, null, errorMessage(error));
      else this.#logger.error("Codex app-server process error", error);
    });

    const stdout = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    stdout.on("line", (line) => this.handleLine(child, line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
    stderr.on("line", (line) => this.#logger.debug("Codex app-server", { line }));

    try {
      await once(child, "spawn");
      const initialized = await this.request<InitializeResponse>({
        method: "initialize",
        params: {
          clientInfo: {
            name: "wirebot",
            title: "Wirebot",
            version: this.#clientVersion,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      });
      const notification: ClientNotification = { method: "initialized" };
      await this.write(notification);
      this.#logger.info("Codex app-server initialized", {
        userAgent: initialized.userAgent,
        platform: initialized.platformOs,
      });
      return initialized;
    } catch (error) {
      if (this.#child === child) {
        await this.stop().catch((stopError: unknown) => {
          this.#logger.error("Could not stop Codex after initialization failed", stopError);
        });
      }
      throw error;
    }
  }

  public onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onExit(listener: ExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  public setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  public async request<Result>(request: ClientRequestInput): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await this.requestOnce(request)) as Result;
      } catch (error) {
        if (
          !(error instanceof CodexRpcError) ||
          error.rpcCode !== TRANSIENT_OVERLOAD_RPC_CODE ||
          attempt >= 3
        ) {
          throw error;
        }
        await delay(100 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
  }

  public async reply(id: RequestId, result: unknown): Promise<void> {
    await this.write({ id, result });
  }

  public async replyError(id: RequestId, code: number, message: string): Promise<void> {
    await this.write({ id, error: { code, message } });
  }

  public async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const killTimer = setTimeout(() => {
      if (this.#child === child && child.exitCode === null) child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref();
    child.kill("SIGTERM");
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }

  private async requestOnce(request: ClientRequestInput): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const pending = deferred<unknown>();
    this.#pending.set(id, { deferred: pending });
    try {
      await this.write({ ...request, id });
      return await withTimeout(pending.promise, 60_000, `Codex RPC ${request.method} timed out`);
    } finally {
      this.#pending.delete(id);
    }
  }

  private async write(message: ClientRequest | ClientNotification | object): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) {
      throw new BridgeError("Codex app-server is not running", "CODEX_NOT_RUNNING");
    }
    if (!child.stdin.write(`${JSON.stringify(message)}\n`, "utf8")) {
      await once(child.stdin, "drain");
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.#child !== child) return;
    let message: z.infer<typeof wireMessageSchema>;
    try {
      message = wireMessageSchema.parse(JSON.parse(line));
    } catch (error) {
      this.#logger.warn("Ignoring invalid Codex app-server message", {
        error: errorMessage(error),
      });
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      if (message.error !== undefined) {
        pending.deferred.reject(
          new CodexRpcError(message.error.message, message.error.code, message.error.data),
        );
      } else {
        pending.deferred.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      const request = message as ServerRequest;
      const handler = this.#serverRequestHandler;
      if (handler === undefined) {
        void this.replyError(message.id, -32_601, "No client handler registered");
      } else {
        void handler(request).catch((error: unknown) => {
          this.#logger.error("Failed to handle Codex server request", error, {
            method: message.method,
          });
          void this.replyError(message.id as RequestId, -32_603, errorMessage(error));
        });
      }
      return;
    }

    if (message.method !== undefined) {
      const notification = message as ServerNotification;
      for (const listener of this.#notificationListeners) listener(notification);
    }
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | string | null,
  ): void {
    if (this.#child !== child) return;
    const expected = this.#stopping;
    const error = new BridgeError(
      `Codex app-server exited (${code ?? signal ?? "unknown"})`,
      "CODEX_EXITED",
    );
    for (const pending of this.#pending.values()) pending.deferred.reject(error);
    this.#pending.clear();
    this.#child = undefined;
    if (!expected) this.#logger.error("Codex app-server stopped unexpectedly", error);
    const exit = { error, expected, code, signal } satisfies CodexAppServerExit;
    for (const listener of this.#exitListeners) {
      try {
        listener(exit);
      } catch (listenerError) {
        this.#logger.error("Codex app-server exit listener failed", listenerError);
      }
    }
  }
}
