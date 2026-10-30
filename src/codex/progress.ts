import { basename } from "node:path";
import type { ProgressAction } from "../core/channel.js";
import type { MessagePhase } from "../generated/codex/MessagePhase.js";
import type { FileUpdateChange } from "../generated/codex/v2/FileUpdateChange.js";
import type { ThreadItem } from "../generated/codex/v2/ThreadItem.js";
import type { Turn } from "../generated/codex/v2/Turn.js";
import { capitalize, compactTruncate } from "../shared/text.js";

export interface AgentMessageText {
  readonly phase: MessagePhase | null;
  readonly text: string;
}

/**
 * Text to deliver from a turn's assistant messages: every answer message in
 * order, since a partial answer is not repeated by the final answer that
 * follows it. Falls back to the last message when no phase marks an answer.
 */
export function finalTextFromMessages(messages: readonly AgentMessageText[]): string {
  const answers = messages.filter(
    (message) => message.phase === "partial_answer" || message.phase === "final_answer",
  );
  const selected = answers.length > 0 ? answers : messages.slice(-1);
  return selected
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");
}

export function finalTextFromTurn(turn: Turn): string {
  return finalTextFromMessages(turn.items.filter((item) => item.type === "agentMessage"));
}

export function progressActions(item: ThreadItem): readonly ProgressAction[] {
  switch (item.type) {
    case "commandExecution":
      return [{ label: commandActionLabel(item) }];
    case "fileChange":
      return fileChangeActions(item.changes, item.status !== "inProgress");
    case "mcpToolCall":
      return [
        {
          label: `${item.status === "inProgress" ? "Calling" : "Called"} ${item.server}.${item.tool}${durationSuffix(item.durationMs)}`,
        },
      ];
    case "dynamicToolCall":
      return [
        {
          label: `${item.status === "inProgress" ? "Calling" : "Called"} ${item.namespace === null ? "" : `${item.namespace}.`}${item.tool}${durationSuffix(item.durationMs)}`,
        },
      ];
    case "collabAgentToolCall":
      return [
        {
          label: `${item.status === "inProgress" ? "Running" : "Ran"} ${collaborationLabel(item.tool)}`,
        },
      ];
    case "webSearch":
      return [{ label: `Searched  ${item.query || "the web"}` }];
    case "imageView":
      return [{ label: `Viewed    ${basename(item.path)}` }];
    case "imageGeneration":
      return [{ label: `${item.status === "inProgress" ? "Generating" : "Generated"} image` }];
    case "sleep":
      return [{ label: `Waited    ${formatDuration(item.durationMs)}` }];
    case "subAgentActivity":
      return [{ label: `${capitalize(item.kind)} agent ${item.agentPath}` }];
    case "enteredReviewMode":
      return [{ label: "Entered review mode" }];
    case "exitedReviewMode":
      return [{ label: "Exited review mode" }];
    default:
      return [];
  }
}

export function fileChangeActions(
  changes: readonly FileUpdateChange[],
  completed: boolean,
): readonly ProgressAction[] {
  return changes.map((change) => {
    const verb =
      change.kind.type === "add"
        ? completed
          ? "Created"
          : "Creating"
        : change.kind.type === "delete"
          ? completed
            ? "Deleted"
            : "Deleting"
          : completed
            ? "Edited"
            : "Editing";
    const counts = diffCounts(change.diff);
    const diffSummary =
      change.kind.type === "delete" || counts.added + counts.removed === 0
        ? ""
        : `   +${counts.added} −${counts.removed}`;
    return { label: `${verb.padEnd(9)} ${basename(change.path)}${diffSummary}` };
  });
}

function commandActionLabel(item: Extract<ThreadItem, { type: "commandExecution" }>): string {
  const completed = item.status !== "inProgress";
  const action = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
  let label: string;
  switch (action?.type) {
    case "read":
      label = `${completed ? "Read" : "Reading"}     ${action.name || basename(action.path)}`;
      break;
    case "listFiles":
      label = `${completed ? "Listed" : "Listing"}  files${action.path === null ? "" : ` in ${basename(action.path)}`}`;
      break;
    case "search":
      label = `${completed ? "Searched" : "Searching"} ${action.query ?? "files"}`;
      break;
    default:
      label = `${completed ? "Ran" : "Running"}      ${compactTruncate(item.command, 120)}`;
  }
  return `${label}${durationSuffix(item.durationMs)}`;
}

function diffCounts(diff: string): Readonly<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function durationSuffix(durationMs: number | null): string {
  return durationMs === null ? "" : `   ${formatDuration(durationMs)}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10}s`;
  return `${Math.round(durationMs / 60_000)}m`;
}

function collaborationLabel(
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"],
): string {
  switch (tool) {
    case "spawnAgent":
      return "spawn agent";
    case "sendInput":
      return "send agent input";
    case "resumeAgent":
      return "resume agent";
    case "wait":
      return "wait for agents";
    case "closeAgent":
      return "close agent";
    case "sendMessage":
      return "message agent";
    case "followupTask":
      return "assign follow-up task";
    case "interruptAgent":
      return "interrupt agent";
    case "listAgents":
      return "list agents";
  }
}
