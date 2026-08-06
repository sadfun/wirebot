import { describe, expect, it } from "bun:test";
import { isWorkspaceMember } from "../src/channels/slack/authorization.js";

const team = "T0EXAMPLE";

describe("isWorkspaceMember", () => {
  it("accepts a regular member of the bot's workspace", () => {
    expect(isWorkspaceMember({ id: "U1", team_id: team }, team)).toBe(true);
  });

  it("rejects users from other workspaces and Slack Connect strangers", () => {
    expect(isWorkspaceMember({ id: "U1", team_id: "T0OTHER" }, team)).toBe(false);
    expect(isWorkspaceMember({ id: "U1", team_id: team, is_stranger: true }, team)).toBe(false);
  });

  it("rejects bots, deactivated accounts, and guests", () => {
    expect(isWorkspaceMember({ id: "U1", team_id: team, is_bot: true }, team)).toBe(false);
    expect(isWorkspaceMember({ id: "U1", team_id: team, deleted: true }, team)).toBe(false);
    expect(isWorkspaceMember({ id: "U1", team_id: team, is_restricted: true }, team)).toBe(false);
    expect(isWorkspaceMember({ id: "U1", team_id: team, is_ultra_restricted: true }, team)).toBe(
      false,
    );
  });

  it("rejects a missing user", () => {
    expect(isWorkspaceMember(undefined, team)).toBe(false);
  });
});
