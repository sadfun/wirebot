import { type AutomationSchedule, isStrictIsoInstant } from "./types.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const maximumCandidateChecks = 10_000;

const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type Weekday = (typeof weekdays)[number];

export class RecurrenceError extends Error {
  public override readonly name = "RecurrenceError";
}

interface ParsedRecurrence {
  readonly frequency: "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";
  readonly interval: number;
  readonly byMinute: ReadonlySet<number> | undefined;
  readonly byHour: ReadonlySet<number> | undefined;
  readonly byDay: ReadonlySet<Weekday> | undefined;
  readonly weekStartsOn: Weekday;
  readonly until: Date | undefined;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: Weekday;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function parseRecurrence(rule: string): ParsedRecurrence {
  const line = extractRuleLine(rule);
  const fields = new Map<string, string>();
  for (const component of line.split(";")) {
    const separator = component.indexOf("=");
    if (separator < 1 || separator === component.length - 1) {
      throw new RecurrenceError(`Invalid RRULE component: ${component}`);
    }
    const key = component.slice(0, separator).trim().toUpperCase();
    const value = component
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (fields.has(key)) throw new RecurrenceError(`Duplicate RRULE field: ${key}`);
    fields.set(key, value);
  }

  const supported = new Set(["FREQ", "INTERVAL", "BYMINUTE", "BYHOUR", "BYDAY", "WKST", "UNTIL"]);
  for (const key of fields.keys()) {
    if (!supported.has(key)) throw new RecurrenceError(`Unsupported RRULE field: ${key}`);
  }

  const frequency = fields.get("FREQ");
  if (
    frequency !== "MINUTELY" &&
    frequency !== "HOURLY" &&
    frequency !== "DAILY" &&
    frequency !== "WEEKLY"
  ) {
    throw new RecurrenceError("FREQ must be MINUTELY, HOURLY, DAILY, or WEEKLY");
  }

  const interval = parseInteger(fields.get("INTERVAL") ?? "1", "INTERVAL", 1, 1_000);
  const byMinute = parseIntegerSet(fields.get("BYMINUTE"), "BYMINUTE", 0, 59);
  const byHour = parseIntegerSet(fields.get("BYHOUR"), "BYHOUR", 0, 23);
  const byDay = parseWeekdaySet(fields.get("BYDAY"));
  const weekStartsOn = parseWeekday(fields.get("WKST") ?? "MO", "WKST");
  const untilValue = fields.get("UNTIL");

  validateCanonicalShape(frequency, fields);

  return {
    frequency,
    interval,
    byMinute,
    byHour,
    byDay,
    weekStartsOn,
    until: untilValue === undefined ? undefined : parseUntil(untilValue),
  };
}

/** Returns the first occurrence strictly after `after`. */
export function nextOccurrence(schedule: AutomationSchedule, after: Date): Date | null {
  assertValidDate(after, "after");
  assertTimeZone(schedule.timeZone);
  const recurrence = parseRecurrence(schedule.rrule);
  const start = new Date(schedule.startAt);
  assertValidDate(start, "startAt");
  if (start.getUTCSeconds() !== 0 || start.getUTCMilliseconds() !== 0) {
    throw new RecurrenceError("startAt must align to a whole minute");
  }

  const startMinute = Math.floor(start.getTime() / minuteMs) * minuteMs;
  const afterMinute = Math.floor(after.getTime() / minuteMs) * minuteMs;
  let cursor = Math.max(startMinute, afterMinute + minuteMs);
  const anchor = zonedParts(new Date(startMinute), schedule.timeZone);
  const allowedMinutes =
    recurrence.byMinute ??
    (recurrence.frequency === "MINUTELY" ? undefined : new Set([anchor.minute]));
  const horizon = searchHorizon(recurrence, cursor);
  let candidateChecks = 0;

  while (cursor <= horizon) {
    candidateChecks += 1;
    if (candidateChecks > maximumCandidateChecks) {
      throw new RecurrenceError(
        "RRULE exceeds Wirebot's bounded recurrence work limit; use a simpler cadence or smaller BY lists",
      );
    }
    const candidate = new Date(cursor);
    if (recurrence.until !== undefined && candidate > recurrence.until) return null;
    const parts = zonedParts(candidate, schedule.timeZone);
    if (
      matches(candidate, parts, startMinute, anchor, recurrence) &&
      !hasEarlierEquivalentLocalMinute(candidate, parts, startMinute, schedule.timeZone)
    ) {
      return candidate;
    }
    cursor = advanceCursor(cursor, parts.minute, allowedMinutes);
  }

  return null;
}

function hasEarlierEquivalentLocalMinute(
  candidate: Date,
  parts: ZonedParts,
  startMinute: number,
  timeZone: string,
): boolean {
  const earliest = Math.max(startMinute, candidate.getTime() - 4 * hourMs);
  for (let cursor = candidate.getTime() - minuteMs; cursor >= earliest; cursor -= minuteMs) {
    const earlier = zonedParts(new Date(cursor), timeZone);
    if (
      earlier.year === parts.year &&
      earlier.month === parts.month &&
      earlier.day === parts.day &&
      earlier.hour === parts.hour &&
      earlier.minute === parts.minute
    ) {
      return true;
    }
  }
  return false;
}

function extractRuleLine(input: string): string {
  const lines = input
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new RecurrenceError("Use exactly one RRULE line; DTSTART belongs in schedule.startAt");
  }
  const line = lines[0] ?? "";
  return line.toUpperCase().startsWith("RRULE:") ? line.slice("RRULE:".length) : line;
}

function validateCanonicalShape(
  frequency: ParsedRecurrence["frequency"],
  fields: ReadonlyMap<string, string>,
): void {
  if (frequency === "MINUTELY" && ["BYMINUTE", "BYHOUR", "BYDAY"].some((key) => fields.has(key))) {
    throw new RecurrenceError(
      "MINUTELY supports INTERVAL and UNTIL only; use HOURLY, DAILY, or WEEKLY for calendar filters",
    );
  }
  if (frequency === "HOURLY" && ["BYHOUR", "BYDAY"].some((key) => fields.has(key))) {
    throw new RecurrenceError(
      "HOURLY supports BYMINUTE only; use DAILY or WEEKLY for hour and weekday filters",
    );
  }
  if (frequency !== "WEEKLY" && fields.has("WKST")) {
    throw new RecurrenceError("WKST is supported only with WEEKLY schedules");
  }
}

function matches(
  candidate: Date,
  parts: ZonedParts,
  startMinute: number,
  anchor: ZonedParts,
  recurrence: ParsedRecurrence,
): boolean {
  if (candidate.getTime() < startMinute) return false;
  if (recurrence.byMinute !== undefined && !recurrence.byMinute.has(parts.minute)) return false;
  if (recurrence.byHour !== undefined && !recurrence.byHour.has(parts.hour)) return false;
  if (recurrence.byDay !== undefined && !recurrence.byDay.has(parts.weekday)) return false;

  const dayIndex = calendarDayIndex(parts);
  const anchorDayIndex = calendarDayIndex(anchor);
  switch (recurrence.frequency) {
    case "MINUTELY": {
      const elapsedMinutes = Math.floor((candidate.getTime() - startMinute) / minuteMs);
      return elapsedMinutes % recurrence.interval === 0;
    }
    case "HOURLY": {
      if (recurrence.byMinute === undefined && parts.minute !== anchor.minute) return false;
      const elapsedLocalHours = dayIndex * 24 + parts.hour - (anchorDayIndex * 24 + anchor.hour);
      return elapsedLocalHours >= 0 && elapsedLocalHours % recurrence.interval === 0;
    }
    case "DAILY": {
      if (recurrence.byMinute === undefined && parts.minute !== anchor.minute) return false;
      if (recurrence.byHour === undefined && parts.hour !== anchor.hour) return false;
      const elapsedDays = dayIndex - anchorDayIndex;
      return elapsedDays >= 0 && elapsedDays % recurrence.interval === 0;
    }
    case "WEEKLY": {
      if (recurrence.byMinute === undefined && parts.minute !== anchor.minute) return false;
      if (recurrence.byHour === undefined && parts.hour !== anchor.hour) return false;
      if (recurrence.byDay === undefined && parts.weekday !== anchor.weekday) return false;
      const startOfWeek = weekStartDay(anchorDayIndex, anchor.weekday, recurrence.weekStartsOn);
      const candidateWeek = weekStartDay(dayIndex, parts.weekday, recurrence.weekStartsOn);
      const elapsedWeeks = Math.floor((candidateWeek - startOfWeek) / 7);
      return elapsedWeeks >= 0 && elapsedWeeks % recurrence.interval === 0;
    }
  }
}

function searchHorizon(recurrence: ParsedRecurrence, cursor: number): number {
  switch (recurrence.frequency) {
    case "MINUTELY": {
      const hasCalendarFilter =
        recurrence.byMinute !== undefined ||
        recurrence.byHour !== undefined ||
        recurrence.byDay !== undefined;
      const cycleMinutes = hasCalendarFilter
        ? leastCommonMultiple(recurrence.interval, 7 * 24 * 60)
        : recurrence.interval;
      return cursor + cycleMinutes * minuteMs + 8 * dayMs;
    }
    case "HOURLY": {
      const hasCalendarFilter = recurrence.byHour !== undefined || recurrence.byDay !== undefined;
      const cycleHours = hasCalendarFilter
        ? leastCommonMultiple(recurrence.interval, 7 * 24)
        : recurrence.interval;
      return cursor + cycleHours * hourMs + 8 * dayMs;
    }
    case "DAILY": {
      const cycleDays =
        recurrence.byDay === undefined
          ? recurrence.interval
          : leastCommonMultiple(recurrence.interval, 7);
      return cursor + (cycleDays + 2) * dayMs;
    }
    case "WEEKLY":
      return cursor + (recurrence.interval * 7 + 7) * dayMs;
  }
}

function leastCommonMultiple(left: number, right: number): number {
  return (left / greatestCommonDivisor(left, right)) * right;
}

function greatestCommonDivisor(left: number, right: number): number {
  let dividend = left;
  let divisor = right;
  while (divisor !== 0) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
}

function advanceCursor(
  cursor: number,
  localMinute: number,
  allowedMinutes: ReadonlySet<number> | undefined,
): number {
  if (allowedMinutes === undefined) return cursor + minuteMs;
  let smallestDelta = 60;
  for (const minute of allowedMinutes) {
    const delta = (minute - localMinute + 60) % 60 || 60;
    if (delta < smallestDelta) smallestDelta = delta;
  }
  return cursor + smallestDelta * minuteMs;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }

  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = englishWeekday(values.weekday ?? "");
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday,
  };
}

function calendarDayIndex(parts: ZonedParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / dayMs);
}

function weekStartDay(dayIndex: number, weekday: Weekday, weekStartsOn: Weekday): number {
  const weekdayIndex = weekdays.indexOf(weekday);
  const startIndex = weekdays.indexOf(weekStartsOn);
  return dayIndex - ((weekdayIndex - startIndex + 7) % 7);
}

function parseIntegerSet(
  value: string | undefined,
  field: string,
  minimum: number,
  maximum: number,
): ReadonlySet<number> | undefined {
  if (value === undefined) return undefined;
  const result = new Set<number>();
  for (const component of value.split(",")) {
    result.add(parseInteger(component, field, minimum, maximum));
  }
  if (result.size === 0) throw new RecurrenceError(`${field} cannot be empty`);
  return result;
}

function parseInteger(value: string, field: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new RecurrenceError(`${field} must contain integers`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RecurrenceError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseWeekdaySet(value: string | undefined): ReadonlySet<Weekday> | undefined {
  if (value === undefined) return undefined;
  const result = new Set<Weekday>();
  for (const component of value.split(",")) result.add(parseWeekday(component, "BYDAY"));
  return result;
}

function parseWeekday(value: string, field: string): Weekday {
  if ((weekdays as readonly string[]).includes(value)) return value as Weekday;
  throw new RecurrenceError(`${field} contains an invalid weekday: ${value}`);
}

function englishWeekday(value: string): Weekday {
  const lookup: Readonly<Record<string, Weekday>> = {
    Sun: "SU",
    Mon: "MO",
    Tue: "TU",
    Wed: "WE",
    Thu: "TH",
    Fri: "FR",
    Sat: "SA",
  };
  const weekday = lookup[value];
  if (weekday === undefined) throw new RecurrenceError(`Unexpected weekday: ${value}`);
  return weekday;
}

function parseUntil(value: string): Date {
  let normalized = value;
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    normalized = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(
      9,
      11,
    )}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  } else if (!isStrictIsoInstant(value)) {
    throw new RecurrenceError("UNTIL must be a UTC RFC 5545 timestamp or offset ISO instant");
  }
  if (!isStrictIsoInstant(normalized)) {
    throw new RecurrenceError("UNTIL is not a real calendar instant");
  }
  const parsed = new Date(normalized);
  assertValidDate(parsed, "UNTIL");
  return parsed;
}

function assertValidDate(date: Date, field: string): void {
  if (!Number.isFinite(date.getTime())) throw new RecurrenceError(`${field} is not a valid date`);
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new RecurrenceError(`Unknown time zone: ${timeZone}`);
  }
}
