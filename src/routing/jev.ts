import { z } from "zod";

/**
 * Jev is TypeSafe's decision model: it answers typed questions about a state
 * with calibrated probabilities instead of generating text. Wirebot only uses
 * the `choice` and `noul` (yes/no) question kinds.
 */
export type JevQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      /** Option id → what that option means. */
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    };

export type JevState = Readonly<Record<string, string | number | boolean | null>>;

export interface JevDecisionRequest {
  readonly state: JevState;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  /** Probability that the statement holds, 0–1. */
  noul: z.number(),
});

const decisionSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [choiceAnswerSchema, noulAnswerSchema]),
  ),
  usage: z.object({ input_tokens: z.number().optional(), cost: z.number().optional() }).optional(),
});

export type JevChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type JevNoulAnswer = z.infer<typeof noulAnswerSchema>;
export type JevDecision = z.infer<typeof decisionSchema>;

export interface JevDecisionClient {
  decide(request: JevDecisionRequest, signal?: AbortSignal): Promise<JevDecision>;
}

export interface OpenRouterJevClientOptions {
  /** OpenRouter Decisions endpoint. */
  readonly endpoint: string;
  readonly apiKey: string;
  /** OpenRouter model id, normally `~typesafe/jev-latest`. */
  readonly model: string;
  readonly fetch?: typeof fetch;
}

/** Calls Jev through OpenRouter's Decisions API. */
export class OpenRouterJevClient implements JevDecisionClient {
  readonly #options: OpenRouterJevClientOptions;
  readonly #fetch: typeof fetch;

  public constructor(options: OpenRouterJevClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async decide(request: JevDecisionRequest, signal?: AbortSignal): Promise<JevDecision> {
    const response = await this.#fetch(this.#options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#options.apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://github.com/sadfun/wirebot",
        "x-title": "Wirebot",
      },
      body: JSON.stringify({
        model: this.#options.model,
        state: request.state,
        questions: request.questions,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `Jev request failed with HTTP ${response.status}${body === "" ? "" : `: ${body}`}`,
      );
    }
    return decisionSchema.parse(await response.json());
  }
}
