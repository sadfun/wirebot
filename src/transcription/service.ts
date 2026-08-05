import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "../shared/errors.js";
import type { TranscriptionTransport } from "./transport.js";

const authSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

const responseSchema = z
  .object({
    text: z.string(),
  })
  .loose();

export interface ChatGptCredentials {
  readonly accessToken: string;
  readonly accountId: string;
}

export type ChatGptCredentialsProvider = () => Promise<ChatGptCredentials>;

export interface VoiceTranscriber {
  transcribe(path: string): Promise<string>;
}

/** Uses the active Codex ChatGPT subscription to transcribe voice messages. */
export class ChatGptVoiceTranscriber implements VoiceTranscriber {
  readonly #authPath: string;
  readonly #transport: TranscriptionTransport;
  readonly #refreshCredentials: () => Promise<void>;
  readonly #credentialsProvider: ChatGptCredentialsProvider | undefined;
  #refreshPromise: Promise<void> | undefined;

  public constructor(
    codexHome: string,
    transport: TranscriptionTransport,
    refreshCredentials: () => Promise<void>,
    credentialsProvider?: ChatGptCredentialsProvider,
  ) {
    this.#authPath = join(codexHome, "auth.json");
    this.#transport = transport;
    this.#refreshCredentials = refreshCredentials;
    this.#credentialsProvider = credentialsProvider;
  }

  public async transcribe(path: string): Promise<string> {
    let credentials = await this.readCredentials();
    if (expiresSoon(credentials.accessToken)) {
      await this.refresh();
      credentials = await this.readCredentials();
    }

    let response = await this.#transport.transcribe({ path, ...credentials });
    if (response.status === 401) {
      await this.refresh();
      credentials = await this.readCredentials();
      response = await this.#transport.transcribe({ path, ...credentials });
    }
    if (response.status !== 200) {
      throw new BridgeError(
        `Voice transcription failed with HTTP ${response.status}`,
        "TRANSCRIPTION_HTTP_ERROR",
      );
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(response.body));
    } catch (error) {
      throw new BridgeError(
        "Voice transcription returned an invalid response",
        "TRANSCRIPTION_INVALID_RESPONSE",
        { cause: error },
      );
    }
    const transcript = parsed.text.trim();
    if (transcript.length === 0) {
      throw new BridgeError("No speech was detected in the voice message", "TRANSCRIPTION_EMPTY");
    }
    return transcript;
  }

  private async readCredentials(): Promise<ChatGptCredentials> {
    if (this.#credentialsProvider !== undefined) return await this.#credentialsProvider();
    let auth: z.infer<typeof authSchema>;
    try {
      auth = authSchema.parse(JSON.parse(await readFile(this.#authPath, "utf8")));
    } catch (error) {
      throw new BridgeError(
        "Voice transcription requires a ChatGPT subscription sign-in through /login",
        "TRANSCRIPTION_CHATGPT_AUTH_REQUIRED",
        { cause: error },
      );
    }
    return {
      accessToken: auth.tokens.access_token,
      accountId: auth.tokens.account_id,
    };
  }

  private async refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) return await this.#refreshPromise;
    const refresh = this.#refreshCredentials().finally(() => {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
    });
    this.#refreshPromise = refresh;
    await refresh;
  }
}

function expiresSoon(accessToken: string, now = Date.now()): boolean {
  try {
    const payload = accessToken.split(".")[1];
    if (payload === undefined) return false;
    const decoded = z
      .object({ exp: z.number() })
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return decoded.exp * 1_000 <= now + 2 * 60_000;
  } catch {
    // Opaque future token formats still get a native refresh-and-retry on 401.
    return false;
  }
}
