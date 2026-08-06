/** Uppercase the first character. */
export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

/** Cap `text` at `limit` characters, ending with an ellipsis when cut. */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Collapse whitespace runs into single spaces, then truncate. */
export function compactTruncate(text: string, limit: number): string {
  return truncate(text.replaceAll(/\s+/g, " ").trim(), limit);
}

export function decodeBase64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Human-readable size for attachment descriptions. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round((bytes / (1_024 * 1_024)) * 10) / 10} MB`;
}

/** Decoded (unverified) JWT payload claims, or undefined for malformed tokens. */
export function jwtPayload(token: string): unknown {
  try {
    const payload = token.split(".")[1];
    return payload === undefined ? undefined : decodeBase64UrlJson(payload);
  } catch {
    return undefined;
  }
}
