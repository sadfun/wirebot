import { createHash, randomBytes } from "node:crypto";
import { type ProviderReference, sameReference } from "../core/channel.js";
import { BridgeError } from "../shared/errors.js";

/** Provider-owned identity and destination, shared by both authentication methods. */
export interface AppPrincipal {
  readonly owner: ProviderReference;
  readonly conversation: ProviderReference;
  readonly deliveryTarget: ProviderReference;
}

interface Grant {
  readonly principal: AppPrincipal;
  readonly expiresAt: number;
}

export const loginLifetimeMs = 5 * 60 * 1_000;
export const sessionLifetimeMs = 12 * 60 * 60 * 1_000;
const capacity = 1_000;

/** In-memory, hashed credentials: restarting Wirebot revokes all browser access. */
export class BrowserAuth {
  readonly #links = new Map<string, Grant>();
  readonly #sessions = new Map<string, Grant>();
  readonly #authorize: (owner: ProviderReference) => boolean | Promise<boolean>;
  readonly #now: () => number;

  public constructor(
    authorize: (owner: ProviderReference) => boolean | Promise<boolean>,
    now: () => number = Date.now,
  ) {
    this.#authorize = authorize;
    this.#now = now;
  }

  public async issue(principal: AppPrincipal): Promise<string> {
    await this.requireAdmin(principal);
    // Only the latest unused link for this admin remains valid.
    for (const [key, grant] of this.#links) {
      if (sameReference(grant.principal.owner, principal.owner)) this.#links.delete(key);
    }
    return this.store(this.#links, principal, loginLifetimeMs);
  }

  public async exchange(token: string): Promise<string> {
    const grant = this.lookup(this.#links, token);
    // Consume synchronously before awaiting authorization to prevent concurrent redemption.
    this.#links.delete(digest(token));
    await this.requireAdmin(grant.principal);
    if (grant.expiresAt <= this.#now()) throw unauthorized();
    return this.store(this.#sessions, grant.principal, sessionLifetimeMs);
  }

  public async authenticate(token: string): Promise<AppPrincipal> {
    const grant = this.lookup(this.#sessions, token);
    await this.requireAdmin(grant.principal);
    // Recheck after async authorization in case of concurrent logout or expiry.
    this.lookup(this.#sessions, token);
    return grant.principal;
  }

  public revoke(token: string): void {
    this.#sessions.delete(digest(token));
  }

  private async requireAdmin(principal: AppPrincipal): Promise<void> {
    const { owner, conversation, deliveryTarget } = principal;
    if (
      owner.resource !== "user" ||
      conversation.resource !== "conversation" ||
      deliveryTarget.resource !== "destination" ||
      owner.provider !== conversation.provider ||
      owner.provider !== deliveryTarget.provider ||
      !(await this.#authorize(owner))
    ) {
      throw new BridgeError("Browser access is limited to Wirebot admins.", "MINIAPP_FORBIDDEN");
    }
  }

  private lookup(entries: Map<string, Grant>, token: string): Grant {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
    const key = digest(token);
    const grant = entries.get(key);
    if (grant === undefined || grant.expiresAt <= this.#now()) {
      entries.delete(key);
      throw unauthorized();
    }
    return grant;
  }

  private store(entries: Map<string, Grant>, principal: AppPrincipal, lifetime: number): string {
    for (const [key, grant] of entries) {
      if (grant.expiresAt <= this.#now()) entries.delete(key);
    }
    if (entries.size >= capacity) {
      throw new BridgeError("Too many browser sessions. Try again later.", "MINIAPP_FORBIDDEN");
    }
    const token = randomBytes(32).toString("base64url");
    entries.set(digest(token), {
      principal: structuredClone(principal),
      expiresAt: this.#now() + lifetime,
    });
    return token;
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unauthorized(): BridgeError {
  return new BridgeError(
    "This sign-in has expired or was already used. Request a new link from the bot.",
    "MINIAPP_UNAUTHORIZED",
  );
}
