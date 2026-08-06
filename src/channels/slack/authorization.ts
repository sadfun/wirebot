/** Subset of a Slack `users.info` user object relevant to authorization. */
export interface SlackUserProfileForAuthorization {
  readonly id?: string;
  readonly team_id?: string;
  readonly deleted?: boolean;
  readonly is_bot?: boolean;
  readonly is_stranger?: boolean;
  readonly is_restricted?: boolean;
  readonly is_ultra_restricted?: boolean;
}

/**
 * Decide whether a user counts as a regular member of the bot's workspace.
 *
 * Socket Mode delivers events only for the installed workspace, but shared
 * channels can still surface outsiders: Slack Connect participants belong to
 * a different team, and single/multi-channel guests are not full members.
 * Bots and deactivated accounts never qualify.
 */
export function isWorkspaceMember(
  user: SlackUserProfileForAuthorization | undefined,
  botTeamId: string,
): boolean {
  if (user === undefined) return false;
  if (user.deleted === true || user.is_bot === true || user.is_stranger === true) return false;
  if (user.is_restricted === true || user.is_ultra_restricted === true) return false;
  return user.team_id === botTeamId;
}
