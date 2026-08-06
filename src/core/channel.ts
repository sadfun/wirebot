export interface ConversationAddress {
  readonly channel: string;
  readonly key: string;
  readonly isPrivate: boolean;
  readonly isGuest: boolean;
  /** Provider-owned destination for messages sent without an inbound request. */
  readonly deliveryTarget?: ProviderReference;
}

/**
 * Opaque reference owned by a messaging provider.
 *
 * Core services persist and compare these values, but only the provider that
 * created a reference may interpret its `id`.
 */
export interface ProviderReference {
  readonly provider: string;
  readonly resource: "conversation" | "destination" | "message" | "user";
  readonly id: string;
}

export function sameReference(left: ProviderReference, right: ProviderReference): boolean {
  return (
    left.provider === right.provider && left.resource === right.resource && left.id === right.id
  );
}

export interface SenderIdentity {
  readonly id: string;
  readonly displayName: string;
}

export interface InboundAttachment {
  readonly kind: "image" | "file" | "voice";
  readonly path: string;
  readonly description: string;
}

export interface InboundCommand {
  readonly name: string;
  readonly args: string;
}

export interface OutboundAttachment {
  readonly path: string;
  readonly filename: string;
}

export interface ActionButton {
  readonly label: string;
  readonly kind: "url" | "webApp";
  readonly url: string;
}

export interface SendOptions {
  readonly button?: ActionButton;
}

export interface MessageCommandAction {
  readonly label: string;
  readonly command: InboundCommand;
}

export interface OutboundMessage {
  readonly text: string;
  readonly attachments?: readonly OutboundAttachment[];
  readonly actions?: readonly MessageCommandAction[];
}

export interface DeliveryReceipt {
  readonly publishedMessages: readonly ProviderReference[];
}

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ProgressAction {
  readonly label: string;
}

export interface ProgressPlanStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export interface ProgressSnapshot {
  readonly summary?: string;
  readonly message?: string;
  readonly actions: readonly ProgressAction[];
  readonly plan: readonly ProgressPlanStep[];
}

export interface OutboundStream {
  start(initialProgress?: ProgressSnapshot): Promise<void>;
  setProgress(progress: ProgressSnapshot): void;
  appendFinal(delta: string): void;
  complete(text: string, attachments?: readonly OutboundAttachment[]): Promise<void>;
  fail(message: string): Promise<void>;
}

export interface MessageResponder {
  createStream(): OutboundStream;
  sendText(text: string, options?: SendOptions): Promise<void>;
  /**
   * Present a choice and resolve with the selected option id. When `signal`
   * aborts (the requester no longer needs an answer), resolve promptly with
   * "decline" and withdraw the prompt from the chat if possible.
   */
  askChoice(
    prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface InboundMessage {
  readonly id: string;
  readonly address: ConversationAddress;
  readonly reference?: ProviderReference;
  readonly replyTo?: ProviderReference;
  readonly sender: SenderIdentity;
  readonly text: string;
  /**
   * True when `text` is channel-synthesized filler describing attached media
   * (for example a voice-message placeholder), not words the user wrote.
   */
  readonly syntheticText?: boolean;
  readonly command?: InboundCommand;
  readonly attachments: readonly InboundAttachment[];
  readonly responder: MessageResponder;
  /**
   * Release provider-owned temporary resources after the message is fully
   * handled. The message handler owns this callback, including across a
   * deferred sign-in replay, and must invoke it at most once.
   */
  readonly dispose?: () => Promise<void>;
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface MessagingChannel {
  readonly name: string;
  /** Re-check a persisted provider principal before unattended work executes. */
  isAuthorized(principal: ProviderReference): boolean | Promise<boolean>;
  start(handler: MessageHandler): Promise<void>;
  publish(target: ProviderReference, message: OutboundMessage): Promise<DeliveryReceipt>;
  stop(): Promise<void>;
}
