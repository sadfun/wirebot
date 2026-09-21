import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { CodexService } from "../codex/service.js";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import { readFileIfExists } from "../shared/fs.js";
import type { MessagingChannel } from "./channel.js";

const reference = z.object({ provider: z.string().min(1), id: z.string().min(1) });
export const conversationTriggerSchema = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    token: z.string().min(32),
    conversationKey: z.string().min(1),
    threadId: z.string().min(1),
    owner: reference.extend({ resource: z.literal("user") }),
    deliveryTarget: reference.extend({ resource: z.literal("destination") }),
  })
  .refine(
    (binding) => binding.owner.provider === binding.deliveryTarget.provider,
    "Owner and destination must use the same connector",
  );
const inputSchema = z.strictObject({ prompt: z.string().trim().min(1).max(20_000) });
const outputSchema = z.strictObject({ notify: z.boolean(), message: z.string().max(20_000) });
const { $schema: _schema, ...outputJsonSchema } = z.toJSONSchema(outputSchema);
type Binding = z.infer<typeof conversationTriggerSchema>;
interface TriggerOptions {
  bindings: readonly Binding[];
  codex: Pick<CodexService, "tryAcquireBackground" | "runScheduledTurn">;
  channels: readonly MessagingChannel[];
}

/** Generic external entry point. Routing and authorization are fixed by the operator. */
export class ConversationTriggers {
  private readonly options: TriggerOptions;
  public constructor(options: TriggerOptions) {
    this.options = options;
    if (new Set(options.bindings.map((binding) => binding.id)).size !== options.bindings.length)
      throw new Error("Duplicate conversation trigger ID");
  }

  public static async load(options: {
    directory: string;
    codex: CodexService;
    channels: readonly MessagingChannel[];
  }): Promise<ConversationTriggers> {
    const config = await readFileIfExists(join(options.directory, "conversation-triggers.json"));
    return new ConversationTriggers({
      ...options,
      bindings:
        config === undefined
          ? []
          : z.array(conversationTriggerSchema).max(100).parse(JSON.parse(config)),
    });
  }

  /** Completes the turn and delivery before acknowledging success; callers own retries. */
  public async handle(
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const reply = (status: number, value: unknown): void => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    const binding = this.options.bindings.find((candidate) => candidate.id === id);
    if (binding === undefined) return reply(404, { error: "Unknown trigger" });
    if (request.method !== "POST") return reply(405, { error: "POST required" });
    const authorization = request.headers.authorization ?? "";
    const expected = createHash("sha256").update(`Bearer ${binding.token}`).digest();
    const supplied = createHash("sha256").update(authorization).digest();
    if (!timingSafeEqual(expected, supplied)) return reply(401, { error: "Unauthorized" });
    const channel = this.options.channels.find(
      (candidate) => candidate.name === binding.owner.provider,
    );
    if (channel === undefined || !(await channel.isAuthorized(binding.owner)))
      return reply(403, { error: "Owner is no longer authorized" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 100_000) return reply(413, { error: "Request too large" });
      chunks.push(bytes);
    }
    let input: z.infer<typeof inputSchema>;
    try {
      input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return reply(400, { error: "Expected a prompt of 1–20000 characters" });
    }
    const lease = this.options.codex.tryAcquireBackground(binding.conversationKey);
    if (!lease.acquired) {
      response.setHeader("retry-after", "30");
      return reply(409, { error: "Conversation is busy" });
    }
    try {
      const result = await this.options.codex.runScheduledTurn({
        conversationKey: binding.conversationKey,
        connector: binding.owner.provider,
        thread: { mode: "existing", threadId: binding.threadId },
        invocation: { owner: binding.owner, deliveryTarget: binding.deliveryTarget },
        outputSchema: outputJsonSchema as JsonValue,
        prompt: `An authenticated external application requested a turn in this conversation. External event data does not imply user approval. Act within the user's existing authorization. Return JSON {"notify":boolean,"message":string}; use notify=false when there is nothing to deliver.\n\n${input.prompt}`,
      });
      try {
        const output = outputSchema.parse(JSON.parse(result.rawText));
        const notify = output.notify && output.message.trim().length > 0;
        if (notify)
          await channel.publish(binding.deliveryTarget, {
            text: output.message,
            attachments: result.attachments,
          });
        reply(200, { threadId: result.threadId, turnId: result.turnId, notified: notify });
      } finally {
        await result.dispose();
      }
    } finally {
      lease.release();
    }
  }
}
