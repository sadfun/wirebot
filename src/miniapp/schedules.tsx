/**
 * The Schedules tab: lists scheduled Codex runs and provides the editor for
 * creating and updating them, including the RRULE mapping helpers.
 */
import {
  CalendarClock,
  ChevronLeft,
  CirclePlus,
  Clock3,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { type FormEvent, type ReactElement, useCallback, useState } from "react";
import type { ManagedSchedule } from "../automations/engine.js";
import {
  requestCreateSchedule,
  requestDeleteSchedule,
  requestSchedules,
  requestUpdateSchedule,
} from "./api.js";
import { ConfirmDialog, ExpandableTextarea } from "./dialogs.js";
import { isDefined, messageOf, useAsync } from "./shared.js";
import {
  confirmDiscardChanges,
  nativeTelegramNavigation,
  notifyHaptic,
  useTelegramBackButton,
  useUnsavedChanges,
} from "./telegram.js";
import { Banner, Button, Caption, Headline, Placeholder, Section, Spinner } from "./ui.js";

type ScheduleCadence = "custom" | "daily" | "hourly" | "minutely" | "weekdays" | "weekly";

interface ScheduleDraft {
  readonly name: string;
  readonly prompt: string;
  readonly cadence: ScheduleCadence;
  readonly interval: string;
  readonly time: string;
  readonly days: readonly string[];
  readonly customRrule: string;
  readonly timeZone: string;
  readonly notificationPolicy: ManagedSchedule["notification_policy"];
}

const weekdayOptions = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
  ["SA", "Sat"],
  ["SU", "Sun"],
] as const;

export function SchedulesManager(): ReactElement {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editing, setEditing] = useState<ManagedSchedule | "new">();
  const [deleting, setDeleting] = useState<ManagedSchedule>();
  const [mutationId, setMutationId] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const schedulesLoad = useAsync(requestSchedules, [loadAttempt]);

  const refresh = (message?: string): void => {
    setEditing(undefined);
    setDeleting(undefined);
    setMutationError(undefined);
    setNotice(message);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const toggleStatus = async (schedule: ManagedSchedule): Promise<void> => {
    if (mutationId !== undefined) return;
    const status = schedule.status === "active" ? "paused" : "active";
    setMutationId(schedule.id);
    setMutationError(undefined);
    try {
      await requestUpdateSchedule(schedule.id, {
        expected_revision: schedule.revision,
        status,
      });
      notifyHaptic("success");
      refresh(status === "active" ? `“${schedule.name}” resumed.` : `“${schedule.name}” paused.`);
    } catch (error) {
      setMutationError(messageOf(error));
      notifyHaptic("error");
    } finally {
      setMutationId(undefined);
    }
  };

  const deleteSchedule = async (schedule: ManagedSchedule): Promise<void> => {
    if (mutationId !== undefined) return;
    setMutationId(schedule.id);
    setMutationError(undefined);
    try {
      await requestDeleteSchedule(schedule.id);
      notifyHaptic("success");
      refresh(`“${schedule.name}” deleted.`);
    } catch (error) {
      setMutationError(messageOf(error));
      notifyHaptic("error");
    } finally {
      setMutationId(undefined);
    }
  };

  if (editing !== undefined) {
    return (
      <ScheduleEditor
        schedule={editing === "new" ? undefined : editing}
        onCancel={() => setEditing(undefined)}
        onSaved={(schedule) => {
          const created = editing === "new";
          refresh(created ? `“${schedule.name}” scheduled.` : `“${schedule.name}” updated.`);
        }}
      />
    );
  }

  const schedules = schedulesLoad.value;
  if (schedules === undefined) {
    if (schedulesLoad.error !== undefined) {
      return (
        <div className="loadingRoot tabbedLoadingRoot">
          <Placeholder
            header="Couldn’t load schedules"
            description={schedulesLoad.error}
            action={
              <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="loadingRoot tabbedLoadingRoot">
        <Placeholder header="Loading schedules" description="Reading your current scheduled runs…">
          <Spinner size="l" />
        </Placeholder>
      </div>
    );
  }

  const ordered = [...schedules].sort(compareSchedules);
  const activeCount = ordered.filter((schedule) => schedule.status === "active").length;
  return (
    <main className="page schedulesPage">
      <header className="pageHeader schedulesHeader">
        <div>
          <Headline Component="h1">Schedules</Headline>
          <Caption className="pageSubtitle">
            {activeCount} active · {ordered.length} total
          </Caption>
        </div>
        <Button
          type="button"
          size="s"
          className="scheduleCreateButton"
          onClick={() => setEditing("new")}
        >
          <CirclePlus className="size-4" aria-hidden="true" />
          New
        </Button>
      </header>
      {notice === undefined ? undefined : (
        <Caption className="scheduleNotice" role="status">
          {notice}
        </Caption>
      )}
      {mutationError === undefined ? undefined : (
        <Banner
          className="bannerSpacing"
          header="Couldn’t update the schedule"
          subheader={mutationError}
        />
      )}
      {ordered.length === 0 ? (
        <div className="scheduleEmpty">
          <Placeholder
            header="Nothing scheduled yet"
            description="Create a recurring task and Wirebot will run it even when the chat is quiet."
            action={<Button onClick={() => setEditing("new")}>Create a schedule</Button>}
          >
            <CalendarClock className="scheduleEmptyIcon" aria-hidden="true" />
          </Placeholder>
        </div>
      ) : (
        <div className="scheduleList">
          {ordered.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              busy={mutationId === schedule.id}
              onEdit={() => setEditing(schedule)}
              onToggle={() => void toggleStatus(schedule)}
              onDelete={() => {
                setMutationError(undefined);
                setDeleting(schedule);
              }}
            />
          ))}
        </div>
      )}
      {deleting === undefined ? undefined : (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          description="This permanently removes the schedule and its retained run history. It cannot be undone."
          error={mutationError}
          busy={mutationId === deleting.id}
          confirmLabel="Delete schedule"
          onCancel={() => {
            if (mutationId === undefined) setDeleting(undefined);
          }}
          onConfirm={() => void deleteSchedule(deleting)}
        />
      )}
    </main>
  );
}

interface ScheduleCardProps {
  readonly schedule: ManagedSchedule;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
}

function ScheduleCard(props: ScheduleCardProps): ReactElement {
  const schedule = props.schedule;
  const nextRun =
    schedule.status === "paused"
      ? "Paused"
      : schedule.next_run_at === null
        ? "No future run"
        : `Next ${formatScheduleDate(schedule.next_run_at, schedule.time_zone)}`;
  return (
    <article className={`scheduleCard scheduleCard-${schedule.status}`}>
      <div className="scheduleCardTopline">
        <span className={`scheduleStatus scheduleStatus-${schedule.status}`}>
          <span aria-hidden="true" />
          {schedule.status === "active" ? "Active" : "Paused"}
        </span>
        <Caption className="scheduleKind">
          {schedule.kind === "heartbeat" ? "Heartbeat" : "Fresh task"}
        </Caption>
      </div>
      <div className="scheduleCardCopy">
        <h2>{schedule.name}</h2>
        <p className="ui-line-clamp-2">{schedule.prompt}</p>
      </div>
      <div className="scheduleTiming">
        <Clock3 className="size-4" aria-hidden="true" />
        <div>
          <strong>{humanizeRrule(schedule.rrule)}</strong>
          <Caption>{`${nextRun} · ${schedule.time_zone}`}</Caption>
        </div>
      </div>
      {schedule.deferral_reason === null ? undefined : (
        <Caption className="scheduleDeferral">Waiting: {schedule.deferral_reason}</Caption>
      )}
      <div className="scheduleActions">
        <Button type="button" mode="bezeled" size="s" disabled={props.busy} onClick={props.onEdit}>
          <Pencil className="size-4" aria-hidden="true" />
          Edit
        </Button>
        <Button type="button" mode="bezeled" size="s" loading={props.busy} onClick={props.onToggle}>
          {schedule.status === "active" ? (
            <Pause className="size-4" aria-hidden="true" />
          ) : (
            <Play className="size-4" aria-hidden="true" />
          )}
          {schedule.status === "active" ? "Pause" : "Resume"}
        </Button>
        <Button
          type="button"
          mode="plain"
          size="s"
          className="scheduleDeleteButton"
          aria-label={`Delete ${schedule.name}`}
          disabled={props.busy}
          onClick={props.onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}

interface ScheduleEditorProps {
  readonly schedule: ManagedSchedule | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (schedule: ManagedSchedule) => void;
}

function ScheduleEditor(props: ScheduleEditorProps): ReactElement {
  const [initialDraft] = useState<ScheduleDraft>(() => scheduleDraft(props.schedule));
  const [draft, setDraft] = useState<ScheduleDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [idempotencyKey] = useState(scheduleAttemptId);
  const existing = props.schedule;
  const dirty = !scheduleDraftsEqual(draft, initialDraft);
  useUnsavedChanges(dirty);

  const cancel = useCallback((): void => {
    if (saving) return;
    if (!dirty) {
      props.onCancel();
      return;
    }
    void confirmDiscardChanges("Discard this schedule draft?").then((confirmed) => {
      if (confirmed) props.onCancel();
    });
  }, [dirty, props.onCancel, saving]);
  useTelegramBackButton(saving ? undefined : cancel);

  const setValue = <Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const validationError = validateScheduleDraft(draft);
    if (validationError !== undefined) {
      setError(validationError);
      notifyHaptic("warning");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const values = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        rrule: rruleFromDraft(draft),
        time_zone: draft.timeZone.trim(),
        notification_policy: draft.notificationPolicy,
      };
      const schedule =
        existing === undefined
          ? await requestCreateSchedule({ ...values, idempotency_key: idempotencyKey })
          : await requestUpdateSchedule(existing.id, {
              ...values,
              expected_revision: existing.revision,
            });
      notifyHaptic("success");
      props.onSaved(schedule);
    } catch (saveError) {
      setError(messageOf(saveError));
      notifyHaptic("error");
    } finally {
      setSaving(false);
    }
  };

  const showInterval = ["daily", "hourly", "minutely", "weekly"].includes(draft.cadence);
  const showTime = ["daily", "hourly", "weekdays", "weekly"].includes(draft.cadence);
  return (
    <form onSubmit={(event) => void submit(event)}>
      <main className="page scheduleEditorPage">
        <header className="skillDetailHeader scheduleEditorHeader">
          {nativeTelegramNavigation ? undefined : (
            <Button type="button" mode="plain" size="s" disabled={saving} onClick={cancel}>
              <ChevronLeft className="size-4" aria-hidden="true" />
              Schedules
            </Button>
          )}
          <Headline Component="h1">
            {existing === undefined ? "New schedule" : "Edit schedule"}
          </Headline>
          <Caption className="pageSubtitle">
            {existing?.kind === "heartbeat"
              ? "This heartbeat continues its original Codex task."
              : "Each run starts a fresh persistent Codex task."}
          </Caption>
        </header>
        {error === undefined ? undefined : (
          <Banner
            className="bannerSpacing"
            header="Couldn’t save this schedule"
            subheader={error}
          />
        )}
        <div className="sectionStack">
          <Section header="Task" footer="Give Codex enough detail to run unattended.">
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-name">
                Name
              </Caption>
              <input
                id="schedule-name"
                className="nativeControl"
                value={draft.name}
                maxLength={200}
                autoComplete="off"
                placeholder="Daily project check"
                disabled={saving}
                onChange={(event) => setValue("name", event.currentTarget.value)}
              />
              <Caption className="fieldHint">
                A short label for notifications and this list.
              </Caption>
            </div>
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-prompt">
                Instructions
              </Caption>
              <ExpandableTextarea
                id="schedule-prompt"
                className="nativeControl nativeTextarea schedulePrompt"
                label="schedule instructions"
                value={draft.prompt}
                maxLength={20_000}
                rows={5}
                placeholder="Check the repository for failed CI runs and summarize anything actionable."
                disabled={saving}
                onValueChange={(value) => setValue("prompt", value)}
              />
              <Caption className="fieldHint">
                This is the full prompt Codex receives on every run.
              </Caption>
            </div>
          </Section>
          <Section
            header="Timing"
            footer="Times use the selected IANA time zone, including daylight saving changes."
          >
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-cadence">
                Repeats
              </Caption>
              <select
                id="schedule-cadence"
                className="nativeControl nativeSelect"
                value={draft.cadence}
                disabled={saving}
                onChange={(event) =>
                  setValue("cadence", event.currentTarget.value as ScheduleCadence)
                }
              >
                <option value="minutely">Every few minutes</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Custom RRULE</option>
              </select>
              <Caption className="fieldHint">
                Common schedules stay readable; custom rules remain editable.
              </Caption>
            </div>
            {showInterval ? (
              <div className="field">
                <Caption Component="label" className="controlLabel" htmlFor="schedule-interval">
                  Every
                </Caption>
                <div className="scheduleIntervalControl">
                  <input
                    id="schedule-interval"
                    className="nativeControl"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1_000}
                    value={draft.interval}
                    disabled={saving}
                    onChange={(event) => setValue("interval", event.currentTarget.value)}
                  />
                  <Caption>{cadenceUnit(draft.cadence, Number(draft.interval))}</Caption>
                </div>
                <Caption className="fieldHint">
                  Use 1 for every {cadenceUnit(draft.cadence, 1)}.
                </Caption>
              </div>
            ) : undefined}
            {showTime ? (
              <div className="field scheduleTimeRow">
                <div>
                  <Caption Component="label" className="controlLabel" htmlFor="schedule-time">
                    {draft.cadence === "hourly" ? "At minute" : "Time"}
                  </Caption>
                  {draft.cadence === "hourly" ? (
                    <input
                      id="schedule-time"
                      className="nativeControl"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={59}
                      value={draft.time.slice(3)}
                      disabled={saving}
                      onChange={(event) =>
                        setValue("time", `00:${event.currentTarget.value.padStart(2, "0")}`)
                      }
                    />
                  ) : (
                    <input
                      id="schedule-time"
                      className="nativeControl"
                      type="time"
                      value={draft.time}
                      disabled={saving}
                      onChange={(event) => setValue("time", event.currentTarget.value)}
                    />
                  )}
                </div>
                <div>
                  <Caption Component="label" className="controlLabel" htmlFor="schedule-time-zone">
                    Time zone
                  </Caption>
                  <input
                    id="schedule-time-zone"
                    className="nativeControl"
                    value={draft.timeZone}
                    maxLength={128}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Europe/Warsaw"
                    disabled={saving}
                    onChange={(event) => setValue("timeZone", event.currentTarget.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="field">
                <Caption Component="label" className="controlLabel" htmlFor="schedule-time-zone">
                  Time zone
                </Caption>
                <input
                  id="schedule-time-zone"
                  className="nativeControl"
                  value={draft.timeZone}
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Europe/Warsaw"
                  disabled={saving}
                  onChange={(event) => setValue("timeZone", event.currentTarget.value)}
                />
                <Caption className="fieldHint">
                  Use an IANA time zone, such as Europe/Warsaw.
                </Caption>
              </div>
            )}
            {draft.cadence === "weekly" ? (
              <fieldset className="field scheduleDaysField">
                <legend className="controlLabel">Days</legend>
                <div className="weekdayPicker">
                  {weekdayOptions.map(([value, label]) => {
                    const selected = draft.days.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        className={
                          selected ? "weekdayButton weekdayButtonSelected" : "weekdayButton"
                        }
                        aria-pressed={selected}
                        disabled={saving}
                        onClick={() =>
                          setValue(
                            "days",
                            selected
                              ? draft.days.filter((day) => day !== value)
                              : [...draft.days, value],
                          )
                        }
                      >
                        {label.slice(0, 2)}
                      </button>
                    );
                  })}
                </div>
                <Caption className="fieldHint">Choose one or more days.</Caption>
              </fieldset>
            ) : undefined}
            {draft.cadence === "custom" ? (
              <div className="field">
                <Caption Component="label" className="controlLabel" htmlFor="schedule-rrule">
                  RRULE
                </Caption>
                <ExpandableTextarea
                  id="schedule-rrule"
                  className="nativeControl nativeTextarea scheduleRrule"
                  label="custom RRULE"
                  value={draft.customRrule}
                  rows={3}
                  maxLength={4_096}
                  spellCheck={false}
                  disabled={saving}
                  onValueChange={(value) => setValue("customRrule", value)}
                />
                <Caption className="fieldHint">
                  One bounded RRULE line; DTSTART is managed by Wirebot.
                </Caption>
              </div>
            ) : undefined}
          </Section>
          <Section
            header="Notifications"
            footer="Heartbeat schedules can decide when a result is important."
          >
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-notifications">
                Notify me
              </Caption>
              <select
                id="schedule-notifications"
                className="nativeControl nativeSelect"
                value={draft.notificationPolicy}
                disabled={saving}
                onChange={(event) =>
                  setValue(
                    "notificationPolicy",
                    event.currentTarget.value as ManagedSchedule["notification_policy"],
                  )
                }
              >
                <option value="always">After every run</option>
                <option value="on-result">Only when there is something to report</option>
                <option value="never">Never</option>
              </select>
              <Caption className="fieldHint">
                Runs still happen when notifications are suppressed.
              </Caption>
            </div>
          </Section>
        </div>
        <div className="scheduleEditorActions">
          <Button type="button" mode="bezeled" size="l" disabled={saving} onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" size="l" loading={saving}>
            {existing === undefined ? "Create schedule" : "Save changes"}
          </Button>
        </div>
      </main>
    </form>
  );
}

function compareSchedules(left: ManagedSchedule, right: ManagedSchedule): number {
  if (left.status !== right.status) return left.status === "active" ? -1 : 1;
  const leftNext = left.next_run_at ?? "9999";
  const rightNext = right.next_run_at ?? "9999";
  const nextOrder = leftNext.localeCompare(rightNext);
  return nextOrder === 0 ? left.name.localeCompare(right.name) : nextOrder;
}

function scheduleDraft(schedule: ManagedSchedule | undefined): ScheduleDraft {
  const now = new Date();
  const defaultTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (schedule === undefined) {
    return {
      name: "",
      prompt: "",
      cadence: "daily",
      interval: "1",
      time: defaultTime,
      days: ["MO"],
      customRrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timeZone: defaultTimeZone,
      notificationPolicy: "always",
    };
  }

  const fields = parseRruleFields(schedule.rrule);
  const frequency = fields?.get("FREQ");
  const interval = fields?.get("INTERVAL") ?? "1";
  const hour = fields?.get("BYHOUR") ?? "0";
  const minute = fields?.get("BYMINUTE") ?? "0";
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const days = fields?.get("BYDAY")?.split(",") ?? ["MO"];
  let cadence: ScheduleCadence = "custom";
  if (fields !== undefined && hasOnlyFields(fields, ["FREQ", "INTERVAL"])) {
    if (frequency === "MINUTELY") cadence = "minutely";
  }
  if (
    fields !== undefined &&
    frequency === "HOURLY" &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYMINUTE"]) &&
    isSingleInteger(minute, 0, 59)
  ) {
    cadence = "hourly";
  }
  if (
    fields !== undefined &&
    frequency === "DAILY" &&
    fields.has("BYHOUR") &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE"]) &&
    isClockFields(hour, minute)
  ) {
    cadence = "daily";
  }
  if (
    fields !== undefined &&
    frequency === "WEEKLY" &&
    fields.has("BYDAY") &&
    fields.has("BYHOUR") &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"]) &&
    isClockFields(hour, minute) &&
    days.every((day) => weekdayOptions.some(([value]) => value === day))
  ) {
    cadence = sameWeekdays(days, ["MO", "TU", "WE", "TH", "FR"]) ? "weekdays" : "weekly";
  }
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    cadence,
    interval,
    time: isClockFields(hour, minute) ? time : defaultTime,
    days,
    customRrule: schedule.rrule,
    timeZone: schedule.time_zone,
    notificationPolicy: schedule.notification_policy,
  };
}

function scheduleDraftsEqual(left: ScheduleDraft, right: ScheduleDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateScheduleDraft(draft: ScheduleDraft): string | undefined {
  if (draft.name.trim().length === 0) return "Add a schedule name.";
  if (draft.prompt.trim().length === 0) return "Add instructions for Codex.";
  if (draft.timeZone.trim().length === 0) return "Add an IANA time zone, such as Europe/Warsaw.";
  if (["daily", "hourly", "minutely", "weekly"].includes(draft.cadence)) {
    const interval = Number(draft.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1_000) {
      return "The repeat interval must be a whole number from 1 to 1000.";
    }
  }
  if (["daily", "hourly", "weekdays", "weekly"].includes(draft.cadence)) {
    const [hour, minute] = draft.time.split(":").map(Number);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour === undefined ||
      minute === undefined ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return draft.cadence === "hourly" ? "Choose a minute from 0 to 59." : "Choose a valid time.";
    }
  }
  if (draft.cadence === "weekly" && draft.days.length === 0) {
    return "Choose at least one day.";
  }
  if (draft.cadence === "custom" && draft.customRrule.trim().length === 0) {
    return "Add a custom RRULE.";
  }
  return undefined;
}

function rruleFromDraft(draft: ScheduleDraft): string {
  if (draft.cadence === "custom") return draft.customRrule.trim();
  const interval = Number(draft.interval);
  const intervalField = interval === 1 ? "" : `;INTERVAL=${interval}`;
  const [hour = "0", minute = "0"] = draft.time.split(":");
  switch (draft.cadence) {
    case "minutely":
      return `FREQ=MINUTELY${intervalField}`;
    case "hourly":
      return `FREQ=HOURLY${intervalField};BYMINUTE=${Number(minute)}`;
    case "daily":
      return `FREQ=DAILY${intervalField};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
    case "weekdays":
      return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
    case "weekly":
      return `FREQ=WEEKLY${intervalField};BYDAY=${orderedWeekdays(draft.days).join(",")};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
  }
}

function humanizeRrule(rule: string): string {
  const fields = parseRruleFields(rule);
  if (fields === undefined) return rule;
  const interval = Number(fields.get("INTERVAL") ?? "1");
  const frequency = fields.get("FREQ");
  const minute = fields.get("BYMINUTE");
  const hour = fields.get("BYHOUR");
  if (!Number.isInteger(interval) || interval < 1) return rule;
  if (frequency === "MINUTELY") {
    return interval === 1 ? "Every minute" : `Every ${interval} minutes`;
  }
  if (frequency === "HOURLY" && minute !== undefined) {
    const suffix = `at :${minute.padStart(2, "0")}`;
    return interval === 1 ? `Every hour ${suffix}` : `Every ${interval} hours ${suffix}`;
  }
  const formattedTime =
    hour !== undefined && minute !== undefined
      ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      : undefined;
  if (frequency === "DAILY" && formattedTime !== undefined) {
    return interval === 1
      ? `Daily at ${formattedTime}`
      : `Every ${interval} days at ${formattedTime}`;
  }
  if (frequency === "WEEKLY" && formattedTime !== undefined) {
    const days = fields.get("BYDAY")?.split(",") ?? [];
    if (sameWeekdays(days, ["MO", "TU", "WE", "TH", "FR"])) {
      return `Weekdays at ${formattedTime}`;
    }
    const labels = orderedWeekdays(days)
      .map((day) => weekdayOptions.find(([value]) => value === day)?.[1])
      .filter(isDefined);
    if (labels.length > 0) {
      const prefix =
        interval === 1 ? labels.join(", ") : `Every ${interval} weeks · ${labels.join(", ")}`;
      return `${prefix} at ${formattedTime}`;
    }
  }
  return rule;
}

function parseRruleFields(rule: string): ReadonlyMap<string, string> | undefined {
  const normalized = rule.trim().replace(/^RRULE:/iu, "");
  if (normalized.length === 0 || /[\r\n]/u.test(normalized)) return undefined;
  const fields = new Map<string, string>();
  for (const component of normalized.split(";")) {
    const separator = component.indexOf("=");
    if (separator <= 0 || separator === component.length - 1) return undefined;
    const key = component.slice(0, separator).trim().toUpperCase();
    const value = component
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (fields.has(key)) return undefined;
    fields.set(key, value);
  }
  return fields;
}

function hasOnlyFields(fields: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return [...fields.keys()].every((key) => allowedSet.has(key));
}

function isClockFields(hour: string, minute: string): boolean {
  return isSingleInteger(hour, 0, 23) && isSingleInteger(minute, 0, 59);
}

function isSingleInteger(value: string, minimum: number, maximum: number): boolean {
  if (!/^\d{1,2}$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function orderedWeekdays(days: readonly string[]): string[] {
  const selected = new Set(days);
  return weekdayOptions.map(([value]) => value).filter((day) => selected.has(day));
}

function sameWeekdays(left: readonly string[], right: readonly string[]): boolean {
  return orderedWeekdays(left).join(",") === orderedWeekdays(right).join(",");
}

function cadenceUnit(cadence: ScheduleCadence, amount: number): string {
  const singular =
    cadence === "minutely"
      ? "minute"
      : cadence === "hourly"
        ? "hour"
        : cadence === "daily"
          ? "day"
          : "week";
  return amount === 1 ? singular : `${singular}s`;
}

function formatScheduleDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function scheduleAttemptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `schedule-${Date.now()}-${Math.random()}`;
}
