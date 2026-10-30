/**
 * Usage limits: the weekly and five-hour windows plus the banked-reset flow,
 * rendered as a card on the phone Settings home and compactly in the desktop
 * rail. Polling lives in the app data provider.
 */
import { type ReactElement, type ReactNode, useState } from "react";
import type { CodexBankedReset, CodexUsageLimitWindow } from "../codex/runtime-service.js";
import { requestApplyBankedReset } from "./api.js";
import { cn } from "./cn.js";
import { useAppData } from "./data.js";
import { ConfirmDialog, Sheet } from "./dialogs.js";
import { isDefined, messageOf } from "./shared.js";
import { notifyHaptic } from "./telegram.js";
import { Badge, Button, Group, Hint, Notice, RowButton, SectionLabel, Spinner } from "./ui.js";

interface ResetConfirmation {
  readonly credit: CodexBankedReset;
  readonly idempotencyKey: string;
}

interface BankedResetFlow {
  readonly count: number;
  readonly notice: string | undefined;
  readonly start: () => void;
  readonly dialogs: ReactNode;
}

function useBankedResetFlow(): BankedResetFlow {
  const { usage } = useAppData();
  const [choosing, setChoosing] = useState(false);
  const [confirmation, setConfirmation] = useState<ResetConfirmation>();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const resets = usage.value?.bankedResets ?? null;
  const count = resets?.availableCount ?? 0;
  const credits = resets?.credits ?? null;
  const available = credits?.filter((credit) => credit.status === "available") ?? [];

  const choose = (credit: CodexBankedReset): void => {
    setError(undefined);
    setChoosing(false);
    setConfirmation({ credit, idempotencyKey: resetAttemptId() });
  };
  const start = (): void => {
    setNotice(undefined);
    if (available.length === 1 && available[0] !== undefined) choose(available[0]);
    else setChoosing(true);
  };
  const closeConfirmation = (): void => {
    if (applying) return;
    setConfirmation(undefined);
    setError(undefined);
  };
  const apply = async (): Promise<void> => {
    if (confirmation === undefined || applying) return;
    setApplying(true);
    setError(undefined);
    try {
      const creditId = confirmation.credit.id;
      const outcome = await requestApplyBankedReset(creditId, confirmation.idempotencyKey);
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        usage.update((current) =>
          current?.bankedResets === null || current === undefined
            ? current
            : {
                ...current,
                bankedResets: {
                  availableCount: Math.max(0, current.bankedResets.availableCount - 1),
                  credits:
                    current.bankedResets.credits?.filter((credit) => credit.id !== creditId) ??
                    null,
                },
              },
        );
        setConfirmation(undefined);
        notifyHaptic("success");
        setNotice(
          outcome === "reset"
            ? "Banked reset applied. Refreshing your usage limits…"
            : "This banked reset was already applied. Refreshing your usage limits…",
        );
        await usage.refresh();
        setNotice(
          outcome === "reset" ? "Banked reset applied." : "This banked reset was already applied.",
        );
        return;
      }
      if (outcome === "nothingToReset") {
        setError("None of your current usage windows are eligible for a reset yet.");
      } else {
        usage.update((current) =>
          current === undefined
            ? current
            : { ...current, bankedResets: { availableCount: 0, credits: [] } },
        );
        setError("This banked reset is no longer available.");
      }
      notifyHaptic("warning");
    } catch (applyError) {
      setError(messageOf(applyError));
      notifyHaptic("error");
    } finally {
      setApplying(false);
    }
  };

  const dialogs = (
    <>
      {choosing ? (
        <Sheet
          title="Banked resets"
          description="Use one to restore every currently eligible Codex usage window."
          onClose={() => setChoosing(false)}
        >
          {credits === null || credits.length === 0 ? (
            <Hint>
              Codex reported {count} banked reset{count === 1 ? "" : "s"} without details.
            </Hint>
          ) : (
            <Group>
              {credits.map((credit) => (
                <div key={credit.id} className="row row-static">
                  <span className="row-copy">
                    <span className="row-label">
                      {credit.title ?? resetTypeLabel(credit.resetType)}
                      <Badge>{resetStatusLabel(credit.status)}</Badge>
                    </span>
                    <span className="row-detail">
                      {credit.description ?? resetTypeLabel(credit.resetType)} · Expires{" "}
                      {formatExpiry(credit.expiresAt)}
                    </span>
                  </span>
                  <Button
                    size="s"
                    variant="secondary"
                    disabled={credit.status !== "available"}
                    onClick={() => choose(credit)}
                  >
                    Apply
                  </Button>
                </div>
              ))}
            </Group>
          )}
          {credits !== null && credits.length > 0 && credits.length < count ? (
            <Hint>{`Codex returned details for ${credits.length} of ${count} banked resets.`}</Hint>
          ) : undefined}
        </Sheet>
      ) : undefined}
      {confirmation === undefined ? undefined : (
        <ConfirmDialog
          title="Apply banked reset?"
          description="This immediately spends one banked reset and restores every eligible Codex usage window. It cannot be undone."
          facts={[
            ["Type", resetTypeLabel(confirmation.credit.resetType)],
            ["Expiration", formatExpiry(confirmation.credit.expiresAt)],
          ]}
          error={error}
          busy={applying}
          confirmLabel="Apply reset"
          onCancel={closeConfirmation}
          onConfirm={() => void apply()}
        />
      )}
    </>
  );
  return { count, notice, start, dialogs };
}

function useUsageWindows(): readonly (readonly [string, CodexUsageLimitWindow])[] {
  const { usage } = useAppData();
  return [
    usage.value?.weekly === null || usage.value?.weekly === undefined
      ? undefined
      : (["Weekly", usage.value.weekly] as const),
    usage.value?.fiveHour === null || usage.value?.fiveHour === undefined
      ? undefined
      : (["5 hours", usage.value.fiveHour] as const),
  ].filter(isDefined);
}

function RefreshLink(): ReactElement {
  const { usage } = useAppData();
  return (
    <button
      type="button"
      className="linkButton"
      disabled={usage.refreshing}
      aria-label="Refresh usage limits"
      onClick={() => void usage.refresh()}
    >
      {usage.refreshing ? "Refreshing…" : "Refresh"}
    </button>
  );
}

/** Stated outright because the backend's answer can't be read from the percentages. */
const usageBlockedText = "Included usage isn't available on this account right now.";

/** The Usage card on the phone Settings home. */
export function UsageCard(): ReactElement {
  const { usage } = useAppData();
  const windows = useUsageWindows();
  const flow = useBankedResetFlow();
  let body: ReactNode;
  if (usage.value === undefined && usage.error === undefined) {
    body = (
      <div className="usage-status" aria-live="polite">
        <Spinner />
        <span>Checking Codex usage…</span>
      </div>
    );
  } else if (usage.value === undefined) {
    body = (
      <div className="usage-status" role="status">
        <strong>Usage unavailable</strong>
        <span>{usage.error}</span>
      </div>
    );
  } else if (windows.length === 0) {
    body = (
      <div className="usage-status" role="status">
        <strong>No active limits</strong>
        <span>Codex is not reporting a weekly or five-hour usage window.</span>
      </div>
    );
  } else {
    body = (
      <>
        {windows.map(([label, window]) => (
          <UsageWindow key={label} label={label} window={window} />
        ))}
        {flow.count > 0 ? (
          <RowButton
            label={`${flow.count} banked reset${flow.count === 1 ? "" : "s"} available`}
            value={<span className="row-action">Use</span>}
            chevron
            onClick={flow.start}
          />
        ) : undefined}
      </>
    );
  }
  return (
    <section className="section">
      <SectionLabel action={<RefreshLink />}>Usage</SectionLabel>
      {flow.notice === undefined ? undefined : <Notice tone="success">{flow.notice}</Notice>}
      {usage.value?.ordinaryUsageAllowed === false ? (
        <Notice tone="warning">{usageBlockedText}</Notice>
      ) : undefined}
      <Group aria-live="polite">{body}</Group>
      {usage.value !== undefined && usage.error !== undefined ? (
        <Hint className="hint-error">{`Could not refresh: ${usage.error}`}</Hint>
      ) : undefined}
      {flow.dialogs}
    </section>
  );
}

/** The compact usage block in the desktop rail footer. */
export function UsageRail(): ReactElement {
  const { usage } = useAppData();
  const windows = useUsageWindows();
  const flow = useBankedResetFlow();
  return (
    <div className="railUsage">
      <div className="railUsage-head">
        <span className="railUsage-label">Usage</span>
        <RefreshLink />
      </div>
      {usage.value === undefined ? (
        <div className="railUsage-note">{usage.error ?? "Checking Codex usage…"}</div>
      ) : windows.length === 0 ? (
        <div className="railUsage-note">No active limits.</div>
      ) : (
        windows.map(([label, window]) => (
          <UsageWindow key={label} label={label} window={window} compact />
        ))
      )}
      {usage.value?.ordinaryUsageAllowed === false ? (
        <div className="railUsage-note railUsage-error">{usageBlockedText}</div>
      ) : undefined}
      {flow.count > 0 ? (
        <button type="button" className="railUsage-reset" onClick={flow.start}>
          <span>{`${flow.count} banked reset${flow.count === 1 ? "" : "s"}`}</span>
          <span className="railUsage-use">Use</span>
        </button>
      ) : undefined}
      {flow.notice === undefined ? undefined : (
        <div className="railUsage-note railUsage-notice">{flow.notice}</div>
      )}
      {usage.value !== undefined && usage.error !== undefined ? (
        <div className="railUsage-note railUsage-error">{`Could not refresh: ${usage.error}`}</div>
      ) : undefined}
      {flow.dialogs}
    </div>
  );
}

interface UsageWindowProps {
  readonly label: string;
  readonly window: CodexUsageLimitWindow;
  readonly compact?: boolean;
}

function UsageWindow({ label, window, compact }: UsageWindowProps): ReactElement {
  const percent = Math.max(0, Math.min(100, window.remainingPercent));
  const level = percent <= 20 ? "low" : percent <= 50 ? "medium" : "healthy";
  return (
    <div className={cn("usage-window", compact && "usage-compact")}>
      <div className="usage-head">
        <span className="usage-name">{label}</span>
        <span className={`usage-remaining usage-${level}`}>{formatRemainingPercent(percent)}</span>
      </div>
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`${label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={`usage-fill usage-${level}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="usage-reset">{formatResetTime(window.resetsAt, compact === true)}</div>
    </div>
  );
}

function resetTypeLabel(type: CodexBankedReset["resetType"]): string {
  return type === "codexRateLimits" ? "Codex usage limits" : "Unknown reset type";
}

function resetStatusLabel(status: CodexBankedReset["status"]): string {
  switch (status) {
    case "available":
      return "Available";
    case "redeeming":
      return "Applying";
    case "redeemed":
      return "Applied";
    default:
      return "Unavailable";
  }
}

function formatUnixDate(seconds: number, withYear: boolean): string | undefined {
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "Does not expire";
  return formatUnixDate(expiresAt, true) ?? "Unavailable";
}

function formatResetTime(resetsAt: number | null, compact: boolean): string {
  if (resetsAt === null) return "Reset time unavailable";
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    date,
  );
  if (sameDay) return `Resets today${compact ? " " : " · "}${time}`;
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    ...(compact ? {} : { month: "short" as const, day: "numeric" as const }),
  }).format(date);
  return `Resets ${day}${compact ? " " : " · "}${time}`;
}

function formatRemainingPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1% left";
  return `${Math.round(percent)}% left`;
}

function resetAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `reset-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
