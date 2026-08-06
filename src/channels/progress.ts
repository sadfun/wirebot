import type { ProgressSnapshot } from "../core/channel.js";

export function formatThinkingBlock(progress: ProgressSnapshot, limit = 800): string {
  const text =
    progress.plan.length > 1 ? formatPlanProgress(progress) : formatActionProgress(progress);
  if (text.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, limit);
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function formatActionProgress(progress: ProgressSnapshot): string {
  const heading = firstLine(progress.summary) || firstLine(progress.message) || "Thinking…";
  const maximumVisibleActions = 4;
  const hiddenActions = Math.max(0, progress.actions.length - maximumVisibleActions);
  const visibleActions = progress.actions.slice(-maximumVisibleActions);
  const rows = [
    ...(hiddenActions === 0 ? [] : [`<${hiddenActions} more actions>`]),
    ...visibleActions.map((action) => action.label),
  ];
  return [
    `▌ ${truncateLine(heading, 180)}`,
    ...rows.map(
      (row, index) => `${index === rows.length - 1 ? "└" : "├"} ${truncateLine(row, 180)}`,
    ),
  ].join("\n");
}

function formatPlanProgress(progress: ProgressSnapshot): string {
  const currentIndex = progress.plan.findIndex((step) => step.status === "inProgress");
  const fallbackIndex = progress.plan.findIndex((step) => step.status === "pending");
  const activeIndex = currentIndex === -1 ? fallbackIndex : currentIndex;
  const context = firstLine(progress.summary) || progress.actions.at(-1)?.label || "";
  const reasoningMessage = progress.message?.trim();
  const lines: string[] = [];

  progress.plan.forEach((step, index) => {
    const isCurrent = index === activeIndex;
    if (isCurrent && lines.length > 0) lines.push("");
    const marker = step.status === "completed" ? "✓" : isCurrent ? "→" : "○";
    const suffix = isCurrent && context.length > 0 ? ` (${truncateLine(context, 140)})` : "";
    lines.push(`${marker} ${truncateLine(step.step, 180)}${suffix}`);
    if (isCurrent && reasoningMessage !== undefined && reasoningMessage !== context) {
      lines.push(truncateLine(reasoningMessage, 240));
    }
    if (isCurrent && index < progress.plan.length - 1) lines.push("");
  });

  return lines.join("\n");
}

function firstLine(text: string | undefined): string {
  return text?.trim().split("\n", 1)[0]?.trim() ?? "";
}

function truncateLine(text: string, limit: number): string {
  const compact = text.replaceAll(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

export function splitMessageText(text: string, limit: number): readonly string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const newline = candidate.lastIndexOf("\n");
    const splitAt = newline > limit / 2 ? newline : limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
