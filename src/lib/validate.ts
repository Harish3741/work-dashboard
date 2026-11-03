import { normaliseFeedUrl } from "./calendar/ics.js";
import type { MoveTarget as BoardMoveTarget } from "./board.js";
import type { ContactInput } from "./contacts.js";
import type { MatchMode, TargetType } from "./types.js";

/**
 * What every write route checks before it calls `src/lib`, in one place.
 *
 * Two callers read a request body: the API routes (the web UI, the old phone
 * gateway) and the cloud applier (`cloud/apply.ts`), which replays ops the
 * phone queued while the computer was asleep. A rule kept in two copies drifts —
 * the phone's copy would accept a date the web refuses, or the other way
 * round — so the routes moved theirs here and both read the same function.
 *
 * Each parser returns the value the lib call takes, or the exact error and
 * status the route answered before this file existed. Errors that come from
 * the lib itself (a row that is gone: 404) stay in the routes.
 */

export type Invalid = { ok: false; error: string; status: number };
export type Parsed<T> = { ok: true; value: T } | Invalid;

function bad(error: string, status = 400): Invalid {
  return { ok: false, error, status };
}

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

type Body = Record<string, unknown>;

export const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MIN = 24 * 60 - 1;

/** A real calendar day, not just the shape: "2026-13-45" would be stored and never shown. */
function isYmd(value: unknown): boolean {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

export function idOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Minutes past midnight, null for untimed, or "invalid" to reject. */
export function parseStartMin(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MIN) return "invalid";
  return minutes;
}

/** null clears the date, false is a rejection. */
export function ymdOrNull(value: unknown): string | null | false {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !YMD.test(value)) return false;
  return value;
}

/**
 * Where a row was dropped in a hand-ordered list (backlog, categories,
 * contacts): the rows either side of the gap, or the bare index the phone's
 * older queue still replays. Null when the body is not a move at all.
 */
export type ListTarget = { beforeId: string | null; afterId: string | null } | { index: number };

export function listTarget(body: Body): Parsed<ListTarget | null> {
  const target: ListTarget | null =
    "beforeId" in body || "afterId" in body
      ? { beforeId: idOrNull(body.beforeId), afterId: idOrNull(body.afterId) }
      : body.toIndex !== undefined
        ? { index: body.toIndex as number }
        : null;
  if (target && "index" in target && (!Number.isInteger(target.index) || target.index < 0)) {
    return bad("A valid target index is required");
  }
  return ok(target);
}

/**
 * Which items the dragged one landed between. The browser sends neighbour keys,
 * which survive a snapshot going stale mid-drag; the phone's offline queue was
 * written before that existed and replays a bare index, so both are accepted.
 */
export function boardMoveTarget(body: Body): BoardMoveTarget | null {
  const key = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  if ("beforeKey" in body || "afterKey" in body) {
    return { beforeKey: key(body.beforeKey), afterKey: key(body.afterKey) };
  }
  if (Number.isInteger(body.toIndex) && (body.toIndex as number) >= 0) {
    return { index: body.toIndex as number };
  }
  return null;
}

/* --------------------------------------------------------------------- tasks */

export function parseTaskCreate(
  body: Body | null,
): Parsed<{ ymd: string; title: string; startMin: number | null }> {
  if (!body || !nonBlank(body.title)) return bad("A title is required");
  if (!isYmd(body.ymd)) return bad("A valid date is required");
  const startMin = parseStartMin(body.startMin);
  if (startMin === "invalid") return bad("Invalid time");
  return ok({ ymd: body.ymd as string, title: body.title, startMin });
}

export type TaskPatch = { title?: string; done?: boolean; ymd?: string; startMin?: number | null };

export function parseTaskPatch(body: Body | null): Parsed<{ id: string; patch: TaskPatch }> {
  if (!body || typeof body.id !== "string") return bad("A task id is required");
  if (body.ymd !== undefined && !isYmd(body.ymd)) return bad("Invalid date");
  if (body.title !== undefined && !nonBlank(body.title)) return bad("A title cannot be empty");
  let startMin: number | null | undefined;
  if ("startMin" in body) {
    const parsed = parseStartMin(body.startMin);
    if (parsed === "invalid") return bad("Invalid time");
    startMin = parsed;
  }
  return ok({
    id: body.id,
    patch: {
      title: body.title as string | undefined,
      done: body.done as boolean | undefined,
      ymd: body.ymd as string | undefined,
      startMin,
    },
  });
}

/* ------------------------------------------------------- need-to-action list */

export function parseActionCreate(body: Body | null): Parsed<{ title: string }> {
  if (!body || !nonBlank(body.title)) return bad("A title is required");
  return ok({ title: body.title });
}

export function parseActionPatch(body: Body | null): Parsed<{
  id: string;
  title?: string;
  done?: boolean;
  reorder: ListTarget | null;
}> {
  if (!body || typeof body.id !== "string") return bad("An id is required");
  if (body.title !== undefined && !nonBlank(body.title)) return bad("A title cannot be empty");
  // The sidebar sends the rows either side of the gap; the phone's queued
  // mutations were written before that and still replay a bare index.
  const reorder = listTarget(body);
  if (!reorder.ok) return reorder;
  return ok({
    id: body.id,
    title: body.title as string | undefined,
    done: body.done as boolean | undefined,
    reorder: reorder.value,
  });
}

/* ---------------------------------------------------------------- completions */

export function parseCompletion(body: Body | null): Parsed<{ key: string; completed: boolean }> {
  if (!body || !nonBlank(body.key) || typeof body.completed !== "boolean") {
    return bad("key and completed are required");
  }
  return ok({ key: body.key, completed: body.completed });
}

/* --------------------------------------------------------------------- board */

export type BoardRequest =
  | { action: "move"; itemKey: string; fromYmd: string; toYmd: string; target: BoardMoveTarget }
  | { action: "time"; itemKey: string; ymd: string; startMin: number | null }
  | { action: "fromBacklog"; itemKey: string; actionId: string; toYmd: string; target: BoardMoveTarget }
  | { action: "toBacklog"; itemKey: string; beforeId: string | null; afterId: string | null }
  | { action: "unpin"; itemKey: string; ymd: string };

/** POST /api/board, every action. See the route for what each one means. */
export function parseBoardRequest(body: Body | null): Parsed<BoardRequest> {
  if (!body || typeof body.itemKey !== "string" || !body.itemKey) {
    return bad("An item key is required");
  }
  const itemKey = body.itemKey;

  if (body.action === "move") {
    if (!isYmd(body.fromYmd) || !isYmd(body.toYmd)) {
      return bad("Valid source and target dates are required");
    }
    const target = boardMoveTarget(body);
    if (!target) return bad("Where the item landed is required");
    return ok({
      action: "move",
      itemKey,
      fromYmd: body.fromYmd as string,
      toYmd: body.toYmd as string,
      target,
    });
  }

  if (body.action === "time") {
    if (!isYmd(body.ymd)) return bad("A valid date is required");
    const startMin = parseStartMin(body.startMin);
    if (startMin === "invalid") return bad("Invalid time");
    return ok({ action: "time", itemKey, ymd: body.ymd as string, startMin });
  }

  if (body.action === "fromBacklog") {
    const actionId = itemKey.startsWith("action:") ? itemKey.slice("action:".length) : "";
    if (!actionId || !isYmd(body.toYmd)) {
      return bad("A backlog item and a valid day are required");
    }
    const target = boardMoveTarget(body);
    if (!target) return bad("Where the item landed is required");
    return ok({ action: "fromBacklog", itemKey, actionId, toYmd: body.toYmd as string, target });
  }

  if (body.action === "toBacklog") {
    return ok({
      action: "toBacklog",
      itemKey,
      beforeId: idOrNull(body.beforeId),
      afterId: idOrNull(body.afterId),
    });
  }

  if (body.action === "unpin") {
    if (!isYmd(body.ymd)) return bad("A valid date is required");
    return ok({ action: "unpin", itemKey, ymd: body.ymd as string });
  }

  return bad("Unknown action");
}

/* -------------------------------------------------------------------- events */

export type LocalEventInput = {
  title: string;
  ymd: string;
  calendarId: string | null;
  startMin: number | null;
  endMin: number | null;
  endYmd: string;
  allDay: boolean;
  notes: string | null;
};

/** POST /api/events. These live only in this app — never sent to iCloud. */
export function parseEventCreate(body: Body | null): Parsed<LocalEventInput> {
  if (!body || !nonBlank(body.title)) return bad("A title is required");
  if (!isYmd(body.ymd)) return bad("A valid date is required");
  const allDay = body.allDay === true || body.startMin == null;
  const endYmd = isYmd(body.endYmd) ? (body.endYmd as string) : (body.ymd as string);
  // A day before the start is refused. An end time before the start on the
  // same day is not: EventDialog sends endYmd = ymd for an overnight
  // 23:00–01:00, and the web has always stored that as typed.
  if (endYmd < (body.ymd as string)) return bad("The event must end after it starts");
  return ok({
    title: body.title,
    ymd: body.ymd as string,
    calendarId: (body.calendarId as string | null | undefined) ?? null,
    startMin: allDay ? null : Number(body.startMin),
    endMin: allDay || body.endMin == null ? null : Number(body.endMin),
    endYmd,
    allDay,
    notes: (body.notes as string | null | undefined) ?? null,
  });
}

export type LocalEventPatch = {
  title?: string;
  ymd?: string;
  startMin?: number | null;
  endMin?: number | null;
  endYmd?: string;
  allDay?: boolean;
  notes?: string | null;
  calendarId?: string | null;
};

export type EventPatchRequest =
  | { kind: "move"; key: string; toYmd: string; toStartMin: number | undefined }
  | { kind: "update"; key: string; id: string; patch: LocalEventPatch };

/** PATCH /api/events: a move (any event; feed ones detach) or a local event's fields. */
export function parseEventPatch(body: Body | null): Parsed<EventPatchRequest> {
  if (!body || typeof body.key !== "string") return bad("An event key is required");

  if (typeof body.toYmd === "string") {
    if (!isYmd(body.toYmd)) return bad("Invalid target date");
    const toStartMin =
      body.toStartMin === undefined || body.toStartMin === null
        ? undefined
        : Math.min(Math.max(Math.round(Number(body.toStartMin)), 0), 24 * 60 - 15);
    if (toStartMin !== undefined && !Number.isFinite(toStartMin)) {
      return bad("Invalid target time");
    }
    return ok({ kind: "move", key: body.key, toYmd: body.toYmd, toStartMin });
  }

  if (!body.key.startsWith("local:")) {
    return bad("feed events are read-only here — drag it to a new day to edit a local copy.", 409);
  }

  if (body.ymd !== undefined && !isYmd(body.ymd)) return bad("Invalid date");
  if (body.endYmd !== undefined && !isYmd(body.endYmd)) return bad("Invalid end date");
  const allDay = body.allDay === true || (body.allDay === undefined ? undefined : false);
  return ok({
    kind: "update",
    key: body.key,
    id: body.key.slice("local:".length),
    patch: {
      title: body.title as string | undefined,
      ymd: body.ymd as string | undefined,
      startMin: body.allDay === true ? null : (body.startMin as number | null | undefined),
      endMin: body.allDay === true ? null : (body.endMin as number | null | undefined),
      endYmd: body.endYmd as string | undefined,
      allDay,
      notes: body.notes as string | null | undefined,
      calendarId: body.calendarId as string | null | undefined,
    },
  });
}

/* -------------------------------------------------------------------- habits */

const TARGET_TYPES: TargetType[] = ["times_per_week", "days_per_week", "every_day"];
const MATCH_MODES: MatchMode[] = ["exact", "contains"];

/** Readings the app knows how to import. Anything else is treated as absent. */
const METRIC_KINDS = ["steps"];

function metricKind(value: unknown): string | null {
  return typeof value === "string" && METRIC_KINDS.includes(value) ? value : null;
}

function metricThreshold(value: unknown): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** every_day is fixed at 7; the others accept 1-21 sessions a week. */
function clampTarget(value: unknown, targetType: TargetType): number {
  if (targetType === "every_day") return 7;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  const ceiling = targetType === "days_per_week" ? 7 : 21;
  return Math.min(Math.max(n, 1), ceiling);
}

export type HabitCreateInput = {
  name: string;
  matchTitle: string;
  matchMode: MatchMode;
  calendarId: string | null;
  targetType: TargetType;
  targetCount: number;
  color: string | undefined;
  metricKind: string | null;
  metricThreshold: number | null;
};

export function parseHabitCreate(body: Body | null): Parsed<HabitCreateInput> {
  if (!body || !nonBlank(body.name)) return bad("A habit name is required");
  const targetType: TargetType = TARGET_TYPES.includes(body.targetType as TargetType)
    ? (body.targetType as TargetType)
    : "times_per_week";
  return ok({
    name: body.name,
    matchTitle: nonBlank(body.matchTitle) ? body.matchTitle : body.name,
    matchMode: MATCH_MODES.includes(body.matchMode as MatchMode) ? (body.matchMode as MatchMode) : "exact",
    calendarId: (body.calendarId as string | null | undefined) ?? null,
    targetType,
    targetCount: clampTarget(body.targetCount, targetType),
    color: typeof body.color === "string" ? body.color : undefined,
    metricKind: metricKind(body.metricKind),
    metricThreshold: metricThreshold(body.metricThreshold),
  });
}

/**
 * PATCH /api/habits. Unusable fields are dropped rather than refused — the
 * route has always worked that way, and the habit form sends its whole state.
 */
export function parseHabitPatch(body: Body | null): Parsed<{ id: string; patch: Record<string, unknown> }> {
  if (!body || typeof body.id !== "string") return bad("A habit id is required");
  const patch: Record<string, unknown> = {};
  if (nonBlank(body.name)) patch.name = body.name;
  if (nonBlank(body.matchTitle)) patch.matchTitle = body.matchTitle;
  if (MATCH_MODES.includes(body.matchMode as MatchMode)) patch.matchMode = body.matchMode;
  if (body.calendarId !== undefined) patch.calendarId = body.calendarId;
  if (TARGET_TYPES.includes(body.targetType as TargetType)) patch.targetType = body.targetType;
  if (body.targetCount !== undefined) {
    patch.targetCount = clampTarget(
      body.targetCount,
      (patch.targetType as TargetType) ?? "times_per_week",
    );
  }
  if (typeof body.color === "string") patch.color = body.color;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  // Both move together: a habit is either driven by a reading or by events.
  if (body.metricKind !== undefined) {
    patch.metricKind = metricKind(body.metricKind);
    patch.metricThreshold = patch.metricKind ? metricThreshold(body.metricThreshold) : null;
  }
  return ok({ id: body.id, patch });
}

/* ----------------------------------------------------------------- calendars */

export function isSupportedFeedUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const parsed = new URL(normaliseFeedUrl(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseCalendarCreate(
  body: Body | null,
): Parsed<{ name: string; url: string; color: string | undefined }> {
  if (!body || !nonBlank(body.name)) return bad("A calendar name is required");
  if (typeof body.url !== "string" || !isSupportedFeedUrl(body.url)) {
    return bad("Enter a published calendar URL (webcal:// or https://)");
  }
  return ok({ name: body.name, url: body.url, color: body.color as string | undefined });
}

export type CalendarPatch = { name?: string; url?: string; color?: string; enabled?: boolean };

export function parseCalendarPatch(body: Body | null): Parsed<{ id: string; patch: CalendarPatch }> {
  if (!body || typeof body.id !== "string") return bad("A calendar id is required");
  if (body.url !== undefined && !isSupportedFeedUrl(body.url)) {
    return bad("Enter a valid calendar URL");
  }
  return ok({
    id: body.id,
    patch: {
      name: body.name as string | undefined,
      url: body.url as string | undefined,
      color: body.color as string | undefined,
      enabled: body.enabled as boolean | undefined,
    },
  });
}

/* -------------------------------------------------------------------- pauses */

export function parsePauseCreate(
  body: Body | null,
): Parsed<{ fromYmd: string; toYmd: string; label: string; originKey: string | null }> {
  if (!body || !isYmd(body.fromYmd) || !isYmd(body.toYmd)) {
    return bad("fromYmd and toYmd are required");
  }
  const label = typeof body.label === "string" ? body.label : "";
  // The board passes the to-do that opened the pause, so deleting that to-do
  // removes the pause too. Only that shape is accepted from a client.
  const originKey =
    typeof body.originKey === "string" && /^task:[\w-]+$/.test(body.originKey) ? body.originKey : null;
  return ok({ fromYmd: body.fromYmd as string, toYmd: body.toYmd as string, label, originKey });
}

/* --------------------------------------------------------------------- notes */

/** Long enough for anything typed by hand, short enough to bound a bad write. */
export const MAX_NOTE_BODY = 64 * 1024;

export function parseNote(body: Body | null): Parsed<{ key: string; body: string }> {
  if (!body || typeof body.key !== "string" || !body.key) return bad("An item key is required");
  if (typeof body.body !== "string") return bad("A note body is required");
  if (body.body.length > MAX_NOTE_BODY) return bad("That note is too long");
  return ok({ key: body.key, body: body.body });
}

/* ------------------------------------------------------------------ contacts */

export const CONTACT_FIELDS = ["name", "role", "org", "email", "phone", "event", "category"] as const;

/** One contact from a body or an import row; null when it has no name. */
export function readContact(row: unknown): ContactInput | null {
  if (!row || typeof row !== "object") return null;
  const source = row as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) return null;
  const contact: ContactInput = { name };
  for (const field of CONTACT_FIELDS) {
    if (field === "name") continue;
    if (typeof source[field] === "string") contact[field] = source[field] as string;
  }
  return contact;
}

export function parseContactPatch(
  body: Body | null,
): Parsed<{ id: string; target: ListTarget | null; patch: Partial<ContactInput> }> {
  if (!body || typeof body.id !== "string") return bad("An id is required");
  if (body.name !== undefined && !nonBlank(body.name)) return bad("A name cannot be empty");
  const target = listTarget(body);
  if (!target.ok) return target;
  const patch: Partial<ContactInput> = {};
  for (const field of CONTACT_FIELDS) {
    if (typeof body[field] === "string") patch[field] = body[field] as string;
  }
  return ok({ id: body.id, target: target.value, patch });
}
