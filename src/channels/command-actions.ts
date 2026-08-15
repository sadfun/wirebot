/**
 * Shared `tx:<name>:<args>` codec for command action buttons. The payload
 * rides in each channel's opaque button value (Telegram callback data, Slack
 * button value, Discord custom_id); channel-specific size limits stay at the
 * call sites.
 */
export function encodeCommandAction(name: string, args: string): string {
  // The decoder's single-line regex is the contract: reject names it would
  // not match and control characters that would break the round-trip.
  if (
    !/^[a-z][a-z0-9_]*$/u.test(name) ||
    [...args].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("Provider command action is not safe for a button payload");
  }
  return `tx:${name}:${args}`;
}

export function decodeCommandAction(
  value: string,
): Readonly<{ name: string; args: string }> | undefined {
  const match = /^tx:([a-z][a-z0-9_]*):(.*)$/u.exec(value);
  const name = match?.[1];
  const args = match?.[2];
  return name === undefined || args === undefined ? undefined : { name, args };
}
