/**
 * Time handling for the habit tracker.
 *
 * The whole app works in a single display timezone (APP_TZ, default
 * Australia/Sydney). Rather than passing `Date` objects around and converting
 * repeatedly, every event is normalised once at ingest into *wall-clock* form:
 *
 *   ymd      "2026-08-15"  — the calendar day it lands on in APP_TZ
 *   startMin 545           — minutes from local midnight (null for all-day)
 *
 * Grid layout, "sort by start time", and weekly goal windows are then plain
 * integer/string arithmetic with no timezone reasoning at all. Only the ICS
 * ingest boundary deals with absolute instants.
 */

export const APP_TZ = process.env.APP_TZ ?? "Australia/Sydney";

/** Day the week starts on for weekly goals and the calendar grid. 1 = Monday. */
export const WEEK_STARTS_ON = 1;

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MS_PER_DAY = 86_400_000;

const ymdFormatterCache = new Map<string, Intl.DateTimeFormat>();

function ymdFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = ymdFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    ymdFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export type WallClock = { ymd: string; minutes: number };

/** Convert an absolute instant into wall-clock date + minutes in `timeZone`. */
export function toWallClock(date: Date, timeZone: string = APP_TZ): WallClock {
  const parts = ymdFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    // Intl renders midnight as 24 in some ICU versions under hourCycle h23.
    minutes: (hour % 24) * 60 + minute,
  };
}

/** Today's date in APP_TZ. */
export function todayYmd(timeZone: string = APP_TZ): string {
  return toWallClock(new Date(), timeZone).ymd;
}

/** Treat a YYYY-MM-DD as UTC midnight — a stable anchor for day arithmetic. */
function ymdToUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToYmd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(ymd: string, days: number): string {
  return utcToYmd(ymdToUtc(ymd) + days * MS_PER_DAY);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((ymdToUtc(to) - ymdToUtc(from)) / MS_PER_DAY);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(ymd: string): number {
  return new Date(ymdToUtc(ymd)).getUTCDay();
}

/** Monday of the week containing `ymd`. */
export function startOfWeek(ymd: string): string {
  const dow = dayOfWeek(ymd);
  const offset = (dow - WEEK_STARTS_ON + 7) % 7;
  return addDays(ymd, -offset);
}

export function endOfWeek(ymd: string): string {
  return addDays(startOfWeek(ymd), 6);
}

export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function addMonths(ymd: string, months: number): string {
  const [y, m] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * The days rendered by the month grid: whole weeks covering the month, so the
 * grid always starts on a Monday and shows trailing/leading days like the
 * macOS Calendar month view.
 */
export function monthGridDays(anchorYmd: string): string[] {
  const first = startOfMonth(anchorYmd);
  const gridStart = startOfWeek(first);
  const lastOfMonth = addDays(addMonths(first, 1), -1);
  const gridEnd = endOfWeek(lastOfMonth);
  const count = daysBetween(gridStart, gridEnd) + 1;
  return Array.from({ length: count }, (_, i) => addDays(gridStart, i));
}

export function weekDays(anchorYmd: string): string[] {
  const start = startOfWeek(anchorYmd);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 545 -> "9:05 am" */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "all-day";
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "09:05" -> 545. Returns null for empty input. */
export function parseTimeInput(value: string): number | null {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** 545 -> "09:05", for <input type="time"> */
export function toTimeInput(minutes: number | null): string {
  if (minutes === null) return "";
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Reading a time the user entered.
 *
 * Three kinds, because the board's control has to tell them apart: `empty` is
 * "nothing here", `invalid` is "you typed something that is not a time", and
 * they mean opposite things on commit. `<input type="time">` could not make
 * that distinction — it reports an empty value for anything incomplete, so a
 * half-entered time and a cleared one arrive identically and nothing the user
 * entered is recoverable from the DOM. That is why the board owns its own
 * hour / minute / am-pm fields now (`readClockFields`) rather than using the
 * native control.
 */
export type ReadTime =
  | { kind: "empty" }
  | { kind: "time"; startMin: number }
  | { kind: "invalid" };

/**
 * A time typed as free text: "9", "930", "9:30", "21:30", "7pm", "7:05 PM".
 *
 * Kept deliberately identical to the phone's `parseTimeInput`
 * (mobile/src/util/date.ts) so both halves of the app read a time the same way
 * — change one and change the other. `parseTimeInput` above stays as it is:
 * EventDialog still uses a native control and wants the strict "HH:MM".
 */
export function readTimeText(value: string): ReadTime {
  const text = value.trim().toLowerCase();
  if (!text) return { kind: "empty" };

  const match = text.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
  if (!match) return { kind: "invalid" };

  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3];
  if (minutes > 59) return { kind: "invalid" };
  if (suffix === "pm" && hours < 12) hours += 12;
  if (suffix === "am" && hours === 12) hours = 0;
  if (hours > 23) return { kind: "invalid" };
  return { kind: "time", startMin: hours * 60 + minutes };
}

/**
 * What closing the board's time editor should do.
 *
 * Walking away from a blank field keeps whatever time the item had; only an
 * explicit commit — Enter — may clear one. That rule predates the text box and
 * still earns its place: a stray keystroke or a select-all should not be able
 * to destroy a time just because the pointer moved somewhere else.
 */
export type TimeCommit =
  /** Leave the item alone and put the old time back in the field. */
  | { action: "keep" }
  /** Nothing to do — the value is what it already was. */
  | { action: "none" }
  /** Typed something, but it is not a time. Say so rather than discard it. */
  | { action: "invalid" }
  | { action: "set"; startMin: number | null };

export type Meridiem = "am" | "pm";

/**
 * The board's own hour / minute / am-pm fields, read as one time.
 *
 * Blank minutes mean o'clock — entering "9" and leaving the minutes alone is
 * the commonest way anyone sets a time, and the native control refused to
 * yield anything at all for it. An hour with no digits is `empty`, but minutes
 * with no hour is `invalid`: there is no sensible time in it, and silently
 * doing nothing is what caused the original complaint.
 */
export function readClockFields(hour: string, minute: string, meridiem: Meridiem): ReadTime {
  const h = hour.trim();
  const m = minute.trim();
  if (h === "" && m === "") return { kind: "empty" };
  if (h === "") return { kind: "invalid" };
  if (!/^\d{1,2}$/.test(h)) return { kind: "invalid" };
  if (m !== "" && !/^\d{1,2}$/.test(m)) return { kind: "invalid" };

  const hours12 = Number(h);
  const minutes = m === "" ? 0 : Number(m);
  if (hours12 < 1 || hours12 > 12) return { kind: "invalid" };
  if (minutes > 59) return { kind: "invalid" };

  const hours = meridiem === "pm" ? (hours12 === 12 ? 12 : hours12 + 12) : hours12 === 12 ? 0 : hours12;
  return { kind: "time", startMin: hours * 60 + minutes };
}

/** 1290 → { hour: "9", minute: "30", meridiem: "pm" }; null → blank fields. */
export function clockFieldsOf(startMin: number | null): {
  hour: string;
  minute: string;
  meridiem: Meridiem;
} {
  if (startMin === null) return { hour: "", minute: "", meridiem: "am" };
  const h24 = Math.floor(startMin / 60) % 24;
  const minutes = startMin % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    hour: String(h12),
    minute: String(minutes).padStart(2, "0"),
    meridiem: h24 < 12 ? "am" : "pm",
  };
}

/** The commit rule itself, over an already-read time. */
export function commitFor(
  read: ReadTime,
  current: number | null,
  /** True only for Enter. Blur is never explicit. */
  explicit: boolean,
): TimeCommit {
  if (read.kind === "invalid") return { action: "invalid" };

  if (read.kind === "empty") {
    if (!explicit) return { action: "keep" };
    return current === null ? { action: "none" } : { action: "set", startMin: null };
  }

  return read.startMin === current
    ? { action: "none" }
    : { action: "set", startMin: read.startMin };
}

/** The same rule over free text — still used by the tests and by anything typed. */
export function decideTimeCommit(
  raw: string,
  current: number | null,
  explicit: boolean,
): TimeCommit {
  return commitFor(readTimeText(raw), current, explicit);
}

export function monthLabel(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-AU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function dayNumber(ymd: string): number {
  return parseInt(ymd.slice(8, 10), 10);
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}
