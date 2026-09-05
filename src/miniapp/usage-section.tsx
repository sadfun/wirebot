/**
 * Usage limits: a self-contained section that polls /api/usage, shows the
 * weekly and five-hour windows, and lets the user spend banked resets.
 */
import { type ReactElement, useCallback, useEffect, useState } from "react";
import type {
  CodexBankedReset,
  CodexBankedResets,
  CodexUsageLimits,
  CodexUsageLimitWindow,
} from "../codex/runtime-service.js";
import { requestApplyBankedReset, requestUsage } from "./api.js";
import { ConfirmDialog } from "./dialogs.js";
import { isDefined, messageOf } from "./shared.js";
import { notifyHaptic } from "./telegram.js";
import { Button, Caption, Section, Spinner } from "./ui.js";

interface ResetConfirmation {
  readonly credit: CodexBankedReset;
  readonly idempotencyKey: string;
}

export function UsageSection(): ReactElement {
  const [usage, setUsage] = useState<CodexUsageLimits>();
  const [usageError, setUsageError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [bankedResetsExpanded, setBankedResetsExpanded] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState<ResetConfirmation>();
  const [resetApplying, setResetApplying] = useState(false);
  const [resetError, setResetError] = useState<string>();
  const [resetNotice, setResetNotice] = useState<string>();

  const refreshUsage = useCallback(async (showRefreshing = true): Promise<void> => {
    if (showRefreshing) setRefreshing(true);
    try {
      setUsage(await requestUsage());
      setUsageError(undefined);
    } catch (error) {
      setUsageError(messageOf(error));
    } finally {
      if (showRefreshing) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
    const timer = window.setInterval(() => void refreshUsage(false), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshUsage]);

  const chooseBankedReset = (credit: CodexBankedReset): void => {
    setResetError(undefined);
    setResetConfirmation({
      credit,
      idempotencyKey: resetAttemptId(),
    });
  };

  const closeResetConfirmation = (): void => {
    if (resetApplying) return;
    setResetConfirmation(undefined);
    setResetError(undefined);
  };

  const applyBankedReset = async (): Promise<void> => {
    if (resetConfirmation === undefined || resetApplying) return;
    setResetApplying(true);
    setResetError(undefined);
    try {
      const creditId = resetConfirmation.credit.id;
      const outcome = await requestApplyBankedReset(creditId, resetConfirmation.idempotencyKey);
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        setUsage((current) => removeAppliedReset(current, creditId));
        setResetNotice(
          outcome === "reset"
            ? "Banked reset applied. Refreshing your usage limits…"
            : "This banked reset was already applied. Refreshing your usage limits…",
        );
        setResetConfirmation(undefined);
        notifyHaptic("success");
        await refreshUsage();
        setResetNotice(
          outcome === "reset" ? "Banked reset applied." : "This banked reset was already applied.",
        );
        return;
      }
      if (outcome === "nothingToReset") {
        setResetError("None of your current usage windows are eligible for a reset yet.");
      } else {
        setUsage((current) => clearUnavailableResets(current));
        setResetError("This banked reset is no longer available.");
      }
      notifyHaptic("warning");
    } catch (error) {
      setResetError(messageOf(error));
      notifyHaptic("error");
    } finally {
      setResetApplying(false);
    }
  };

  const windows = [
    usage?.weekly === null || usage?.weekly === undefined
      ? undefined
      : (["Weekly", usage.weekly] as const),
    usage?.fiveHour === null || usage?.fiveHour === undefined
      ? undefined
      : (["5 hours", usage.fiveHour] as const),
  ].filter(isDefined);
  let body: ReactElement;
  if (usage === undefined && usageError === undefined) {
    body = (
      <div className="usageLoading" aria-live="polite">
        <Spinner />
        <Caption>Checking Codex usage…</Caption>
      </div>
    );
  } else if (usage === undefined) {
    body = (
      <div className="usageUnavailable" role="status">
        <strong>Usage unavailable</strong>
        <Caption>{usageError}</Caption>
      </div>
    );
  } else if (windows.length === 0) {
    body = (
      <div className="usageUnavailable" role="status">
        <strong>No active limits</strong>
        <Caption>Codex is not reporting a weekly or five-hour usage window.</Caption>
      </div>
    );
  } else {
    body = (
      <div className="usageWindows" aria-live="polite">
        {windows.map(([label, window]) => (
          <UsageWindow key={label} label={label} window={window} />
        ))}
        {usage.bankedResets !== null && usage.bankedResets.availableCount > 0 ? (
          <BankedResets
            resets={usage.bankedResets}
            expanded={bankedResetsExpanded}
            notice={resetNotice}
            onToggle={() => setBankedResetsExpanded((expanded) => !expanded)}
            onChoose={chooseBankedReset}
          />
        ) : undefined}
        {usageError === undefined ? undefined : (
          <Caption className="usageStale">{`Could not refresh: ${usageError}`}</Caption>
        )}
      </div>
    );
  }

  return (
    <>
      <Section
        header={
          <div className="usageHeader">
            <span>Usage limits</span>
            <Button
              type="button"
              mode="plain"
              size="s"
              className="usageRefresh"
              loading={refreshing}
              disabled={refreshing}
              onClick={() => void refreshUsage()}
              aria-label="Refresh usage limits"
            >
              Refresh
            </Button>
          </div>
        }
        footer="Refreshes automatically. The five-hour limit appears only while Codex reports that window."
      >
        {body}
      </Section>
      {resetConfirmation === undefined ? undefined : (
        <ConfirmDialog
          title="Apply banked reset?"
          description="This immediately spends one banked reset and restores every eligible Codex usage window. It cannot be undone."
          facts={[
            ["Type", resetTypeLabel(resetConfirmation.credit.resetType)],
            ["Expiration", formatExpiry(resetConfirmation.credit.expiresAt)],
          ]}
          error={resetError}
          busy={resetApplying}
          confirmLabel="Apply reset"
          onCancel={closeResetConfirmation}
          onConfirm={() => void applyBankedReset()}
        />
      )}
    </>
  );
}

interface BankedResetsProps {
  readonly resets: CodexBankedResets;
  readonly expanded: boolean;
  readonly notice: string | undefined;
  readonly onToggle: () => void;
  readonly onChoose: (credit: CodexBankedReset) => void;
}

function BankedResets(props: BankedResetsProps): ReactElement {
  const count = props.resets.availableCount;
  const credits = props.resets.credits ?? [];
  return (
    <div className="bankedResets">
      <button
        type="button"
        className="bankedResetsSummary"
        aria-expanded={props.expanded}
        aria-controls="banked-reset-details"
        onClick={props.onToggle}
      >
        <span className="bankedResetsSummaryCopy">
          <strong>{`You have ${count} banked reset${count === 1 ? "" : "s"}`}</strong>
          <Caption>Use one to restore every currently eligible Codex usage window.</Caption>
        </span>
        <span className={`bankedResetsChevron ${props.expanded ? "bankedResetsChevronOpen" : ""}`}>
          ⌄
        </span>
      </button>
      {props.expanded ? (
        <div id="banked-reset-details" className="bankedResetDetails">
          {props.notice === undefined ? undefined : (
            <Caption className="bankedResetNotice" role="status">
              {props.notice}
            </Caption>
          )}
          {credits.length === 0 ? (
            <div className="bankedResetEmpty">
              <strong>Reset details unavailable</strong>
              <Caption>Codex reported the banked count without individual reset details.</Caption>
            </div>
          ) : (
            credits.map((credit) => (
              <BankedResetCard key={credit.id} credit={credit} onChoose={props.onChoose} />
            ))
          )}
          {credits.length > 0 && credits.length < count ? (
            <Caption className="bankedResetPartial">
              {`Codex returned details for ${credits.length} of ${count} banked resets.`}
            </Caption>
          ) : undefined}
        </div>
      ) : undefined}
    </div>
  );
}

interface BankedResetCardProps {
  readonly credit: CodexBankedReset;
  readonly onChoose: (credit: CodexBankedReset) => void;
}

function BankedResetCard({ credit, onChoose }: BankedResetCardProps): ReactElement {
  const available = credit.status === "available";
  return (
    <article className="bankedReset">
      <div className="bankedResetHeader">
        <strong>{credit.title ?? resetTypeLabel(credit.resetType)}</strong>
        <span className={`bankedResetStatus bankedResetStatus-${credit.status}`}>
          {resetStatusLabel(credit.status)}
        </span>
      </div>
      <dl className="bankedResetFacts">
        <div>
          <dt>Type</dt>
          <dd>{resetTypeLabel(credit.resetType)}</dd>
        </div>
        <div>
          <dt>Expiration</dt>
          <dd>{formatExpiry(credit.expiresAt)}</dd>
        </div>
      </dl>
      {credit.description === null ? undefined : (
        <Caption className="bankedResetDescription">{credit.description}</Caption>
      )}
      <Button
        type="button"
        mode="bezeled"
        size="s"
        stretched
        disabled={!available}
        onClick={() => onChoose(credit)}
      >
        {available ? "Apply this reset" : resetStatusLabel(credit.status)}
      </Button>
    </article>
  );
}

interface UsageWindowProps {
  readonly label: string;
  readonly window: CodexUsageLimitWindow;
}

function UsageWindow({ label, window }: UsageWindowProps): ReactElement {
  const percent = Math.max(0, Math.min(100, window.remainingPercent));
  const percentText = formatRemainingPercent(percent);
  const level = percent <= 20 ? "low" : percent <= 50 ? "medium" : "healthy";
  return (
    <div className="usageWindow">
      <div className="usageWindowHeader">
        <strong>{label}</strong>
        <span className={`usageRemaining usageRemaining-${level}`}>{percentText}</span>
      </div>
      <div
        className="usageTrack"
        role="progressbar"
        aria-label={`${label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={`usageFill usageFill-${level}`} style={{ width: `${percent}%` }} />
      </div>
      <Caption className="usageReset">{formatResetTime(window.resetsAt)}</Caption>
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

function formatResetTime(resetsAt: number | null): string {
  const formatted = resetsAt === null ? undefined : formatUnixDate(resetsAt, false);
  return formatted === undefined ? "Reset time unavailable" : `Resets ${formatted}`;
}

function formatRemainingPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1% left";
  return `${Math.round(percent)}% left`;
}

function removeAppliedReset(
  usage: CodexUsageLimits | undefined,
  creditId: string,
): CodexUsageLimits | undefined {
  if (usage?.bankedResets === null || usage === undefined) return usage;
  return {
    ...usage,
    bankedResets: {
      availableCount: Math.max(0, usage.bankedResets.availableCount - 1),
      credits: usage.bankedResets.credits?.filter((credit) => credit.id !== creditId) ?? null,
    },
  };
}

function clearUnavailableResets(usage: CodexUsageLimits | undefined): CodexUsageLimits | undefined {
  return usage === undefined
    ? usage
    : { ...usage, bankedResets: { availableCount: 0, credits: [] } };
}

function resetAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `reset-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
