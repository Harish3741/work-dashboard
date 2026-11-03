import { db, newId, nowIso } from "./db.js";
import { addDays, endOfWeek, startOfWeek, todayYmd } from "./time.js";
import { indexForNeighbours } from "./order.js";
import { relinkNote } from "./notes.js";
import { listPauses, pausedDaysInWeek, type PauseRecord } from "./pauses.js";
import type {
  CalendarRecord,
  HabitProgress,
  HabitRecord,
  MatchMode,
  Occurrence,
  TargetType,
} from "./types.js";

/* ------------------------------------------------------------------ calendars */

type CalendarRow = Omit<CalendarRecord, "enabled"> & { enabled: number };

export function listCalendars(): CalendarRecord[] {
  const rows = db()
    .prepare(
      `SELECT id, name, color, kind, url, enabled, position
         FROM calendars ORDER BY position, name`,
    )
    .all() as CalendarRow[];
  return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
}

export function createCalendar(input: {
  name: string;
  url: string;
  color?: string;
  kind?: string;
  /**
   * The phone mints ids for what it creates (docs/cloud-sync.md, "Ops"), so a
   * replayed create finds its row and changes nothing. Every create function
   * below takes one the same way; the default is a fresh id, as before.
   */
  id?: string;
}): CalendarRecord {
  const conn = db();
  const existing = input.id ? listCalendars().find((c) => c.id === input.id) : undefined;
  if (existing) return existing;
  const max = conn.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM calendars").get() as {
    p: number;
  };
  const id = input.id ?? newId();
  conn
    .prepare(
      `INSERT INTO calendars (id, name, color, kind, url, enabled, position)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(id, input.name.trim(), input.color ?? "#8b8b8b", input.kind ?? "ics", input.url.trim(), max.p + 1);
  return listCalendars().find((c) => c.id === id)!;
}

export function updateCalendar(
  id: string,
  patch: Partial<Pick<CalendarRecord, "name" | "url" | "color" | "enabled">>,
): void {
  const conn = db();
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.name !== undefined) (sets.push("name = @name"), (params.name = patch.name.trim()));
  if (patch.url !== undefined) (sets.push("url = @url"), (params.url = patch.url.trim()));
  if (patch.color !== undefined) (sets.push("color = @color"), (params.color = patch.color));
  if (patch.enabled !== undefined)
    (sets.push("enabled = @enabled"), (params.enabled = patch.enabled ? 1 : 0));
  if (!sets.length) return;
  conn.prepare(`UPDATE calendars SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function deleteCalendar(id: string): void {
  db().prepare("DELETE FROM calendars WHERE id = ?").run(id);
}

/* -------------------------------------------------------------------- habits */

type HabitRow = Omit<HabitRecord, "archived"> & { archived: number };

function toHabit(row: HabitRow): HabitRecord {
  return { ...row, archived: !!row.archived };
}

export function listHabits(includeArchived = false): HabitRecord[] {
  const rows = db()
    .prepare(
      `SELECT id, name, match_title AS matchTitle, match_mode AS matchMode,
              calendar_id AS calendarId, target_type AS targetType,
              target_count AS targetCount, color, archived, position,
              metric_kind AS metricKind, metric_threshold AS metricThreshold,
              created_at AS createdAt
         FROM habits
        ${includeArchived ? "" : "WHERE archived = 0"}
        ORDER BY position, name`,
    )
    .all() as HabitRow[];
  return rows.map(toHabit);
}

export function createHabit(input: {
  name: string;
  matchTitle?: string;
  matchMode?: MatchMode;
  calendarId?: string | null;
  targetType?: TargetType;
  targetCount?: number;
  color?: string;
  /** Set to drive the habit from imported readings instead of ticked events. */
  metricKind?: string | null;
  metricThreshold?: number | null;
  /** Insert-if-absent, as in createCalendar. */
  id?: string;
}): HabitRecord {
  const conn = db();
  const existing = input.id ? listHabits(true).find((h) => h.id === input.id) : undefined;
  if (existing) return existing;
  const max = conn.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM habits").get() as {
    p: number;
  };
  const id = input.id ?? newId();
  const name = input.name.trim();
  conn
    .prepare(
      `INSERT INTO habits
         (id, name, match_title, match_mode, calendar_id, target_type, target_count, color,
          archived, position, metric_kind, metric_threshold, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      (input.matchTitle ?? name).trim(),
      input.matchMode ?? "exact",
      input.calendarId ?? null,
      input.targetType ?? "times_per_week",
      input.targetCount ?? 1,
      input.color ?? "#e8734a",
      max.p + 1,
      input.metricKind ?? null,
      input.metricThreshold ?? null,
      // A date, not a timestamp: only the week it falls in is ever used.
      todayYmd(),
    );
  return listHabits(true).find((h) => h.id === id)!;
}

export function updateHabit(id: string, patch: Partial<HabitRecord>): void {
  const columns: Record<string, string> = {
    name: "name",
    matchTitle: "match_title",
    matchMode: "match_mode",
    calendarId: "calendar_id",
    targetType: "target_type",
    targetCount: "target_count",
    color: "color",
    position: "position",
    metricKind: "metric_kind",
    metricThreshold: "metric_threshold",
  };
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key as keyof HabitRecord];
    if (value === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = typeof value === "string" ? value.trim() : value;
  }
  if (patch.archived !== undefined) {
    sets.push("archived = @archived");
    params.archived = patch.archived ? 1 : 0;
  }
  if (!sets.length) return;
  db().prepare(`UPDATE habits SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function deleteHabit(id: string): void {
  db().prepare("DELETE FROM habits WHERE id = ?").run(id);
}

/* --------------------------------------------------------------- occurrences */

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** First habit whose title rule and calendar scope match this event. */
function matchHabit(
  habits: HabitRecord[],
  title: string,
  calendarId: string | null,
): HabitRecord | null {
  const haystack = normalise(title);
  for (const habit of habits) {
    // Driven by data, not by events: it must not adopt a same-named event.
    if (habit.metricKind) continue;
    if (habit.calendarId && habit.calendarId !== calendarId) continue;
    const needle = normalise(habit.matchTitle);
    if (!needle) continue;
    const hit = habit.matchMode === "contains" ? haystack.includes(needle) : haystack === needle;
    if (hit) return habit;
  }
  return null;
}

/**
 * The habit a to-do credits, matched on title alone.
 *
 * Calendar scope is deliberately ignored here. It answers "which calendar's
 * events count", and a to-do belongs to no calendar — honouring it would mean a
 * habit pinned to one calendar could never be credited from the board, which is
 * the opposite of what the scope is for. A title you typed yourself is not
 * ambiguous in the way a synced event title is.
 */
function habitForTask(habits: HabitRecord[], title: string): HabitRecord | null {
  const haystack = normalise(title);
  for (const habit of habits) {
    // Driven by data, not by anything you tick.
    if (habit.metricKind) continue;
    const needle = normalise(habit.matchTitle);
    if (!needle) continue;
    const hit = habit.matchMode === "contains" ? haystack.includes(needle) : haystack === needle;
    if (hit) return habit;
  }
  return null;
}

type IcsRow = {
  key: string;
  calendarId: string;
  title: string;
  ymd: string;
  startMin: number | null;
  endYmd: string;
  endMin: number | null;
  allDay: number;
  notes: string | null;
  fromGoogle: number;
};

type LocalRow = {
  id: string;
  calendarId: string | null;
  title: string;
  ymd: string;
  startMin: number | null;
  endYmd: string;
  endMin: number | null;
  allDay: number;
  notes: string | null;
  detachedFromKey: string | null;
};

/** Sort key: all-day events first, then by start time, then title. */
function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const aMin = a.startMin ?? 0;
  const bMin = b.startMin ?? 0;
  if (aMin !== bMin) return aMin - bMin;
  return a.title.localeCompare(b.title);
}

export function getOccurrences(fromYmd: string, toYmd: string): Occurrence[] {
  const conn = db();
  const habits = listHabits();

  const icsAll = conn
    .prepare(
      `SELECT e.key, e.calendar_id AS calendarId, e.title, e.ymd,
              e.start_min AS startMin, e.end_ymd AS endYmd, e.end_min AS endMin,
              e.all_day AS allDay, e.notes,
              (c.url LIKE '%calendar.google.com%') AS fromGoogle
         FROM ics_events e
         JOIN calendars c ON c.id = e.calendar_id
        WHERE e.ymd BETWEEN ? AND ?
          AND c.enabled = 1
          AND e.key NOT IN (SELECT key FROM hidden_occurrences)`,
    )
    .all(fromYmd, toYmd) as IcsRow[];
  const icsRows = icsAll;

  const localRows = conn
    .prepare(
      `SELECT id, calendar_id AS calendarId, title, ymd, start_min AS startMin,
              end_ymd AS endYmd, end_min AS endMin, all_day AS allDay, notes,
              detached_from_key AS detachedFromKey
         FROM local_events
        WHERE ymd BETWEEN ? AND ?`,
    )
    .all(fromYmd, toYmd) as LocalRow[];

  const completedKeys = new Set(
    (
      conn
        .prepare("SELECT occurrence_key AS key FROM completions WHERE ymd BETWEEN ? AND ?")
        .all(fromYmd, toYmd) as { key: string }[]
    ).map((r) => r.key),
  );

  const decorate = (
    key: string,
    origin: "ics" | "local",
    row: { title: string; calendarId: string | null },
  ) => {
    const habit = matchHabit(habits, row.title, row.calendarId);
    return {
      key,
      origin,
      habitId: habit?.id ?? null,
      habitName: habit?.name ?? null,
      habitColor: habit?.color ?? null,
      completed: completedKeys.has(key),
    };
  };

  const out: Occurrence[] = [
    ...withoutGoogleCopies(icsRows, localRows).map((r) => ({
      ...decorate(r.key, "ics" as const, r),
      calendarId: r.calendarId,
      title: r.title,
      ymd: r.ymd,
      startMin: r.startMin,
      endYmd: r.endYmd,
      endMin: r.endMin,
      allDay: !!r.allDay,
      notes: r.notes,
      detachedFromKey: null,
    })),
    ...localRows.map((r) => ({
      ...decorate(`local:${r.id}`, "local" as const, r),
      calendarId: r.calendarId,
      title: r.title,
      ymd: r.ymd,
      startMin: r.startMin,
      endYmd: r.endYmd,
      endMin: r.endMin,
      allDay: !!r.allDay,
      notes: r.notes,
      detachedFromKey: r.detachedFromKey,
    })),
  ];

  return out.sort((a, b) => (a.ymd === b.ymd ? compareOccurrences(a, b) : a.ymd.localeCompare(b.ymd)));
}

/**
 * An invite the user already copied into another calendar by hand would show
 * twice. Titles rarely agree, so the slot decides: a timed Google
 * event starting the same minute on the same day as one of the user's own
 * events (any other calendar, or a local event) is left out, and the user's
 * own copy stands. All-day events are never matched — birthdays and
 * deadlines share "all day" without being the same thing.
 */
function withoutGoogleCopies(icsRows: IcsRow[], localRows: LocalRow[]): IcsRow[] {
  const slot = (r: { ymd: string; startMin: number | null; allDay: number }) =>
    r.allDay || r.startMin == null ? null : `${r.ymd} ${r.startMin}`;
  const taken = new Set<string>();
  for (const r of [...icsRows.filter((row) => !row.fromGoogle), ...localRows]) {
    const s = slot(r);
    if (s) taken.add(s);
  }
  return icsRows.filter((r) => {
    if (!r.fromGoogle) return true;
    const s = slot(r);
    return !s || !taken.has(s);
  });
}

/* -------------------------------------------------------------- local events */

export function createLocalEvent(input: {
  title: string;
  ymd: string;
  calendarId?: string | null;
  startMin?: number | null;
  endMin?: number | null;
  endYmd?: string;
  allDay?: boolean;
  notes?: string | null;
  detachedFromKey?: string | null;
  /** Insert-if-absent, as in createCalendar. */
  id?: string;
}): string {
  if (input.id && db().prepare("SELECT 1 FROM local_events WHERE id = ?").get(input.id)) {
    return input.id;
  }
  const id = input.id ?? newId();
  const allDay = input.allDay ?? input.startMin == null;
  db()
    .prepare(
      `INSERT INTO local_events
         (id, calendar_id, title, ymd, start_min, end_ymd, end_min, all_day, notes, detached_from_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.calendarId ?? null,
      input.title.trim(),
      input.ymd,
      allDay ? null : (input.startMin ?? null),
      input.endYmd ?? input.ymd,
      allDay ? null : (input.endMin ?? null),
      allDay ? 1 : 0,
      input.notes ?? null,
      input.detachedFromKey ?? null,
      nowIso(),
    );
  return id;
}

export function updateLocalEvent(
  id: string,
  patch: {
    title?: string;
    ymd?: string;
    startMin?: number | null;
    endMin?: number | null;
    endYmd?: string;
    allDay?: boolean;
    notes?: string | null;
    calendarId?: string | null;
  },
): void {
  const columns: Record<string, string> = {
    title: "title",
    ymd: "ymd",
    startMin: "start_min",
    endMin: "end_min",
    endYmd: "end_ymd",
    notes: "notes",
    calendarId: "calendar_id",
  };
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key as keyof typeof patch];
    if (value === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = typeof value === "string" && key === "title" ? value.trim() : value;
  }
  if (patch.allDay !== undefined) {
    sets.push("all_day = @allDay");
    params.allDay = patch.allDay ? 1 : 0;
  }
  if (!sets.length) return;
  db().prepare(`UPDATE local_events SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Take a feed occurrence off the board. The feed is read-only, so this
 * hides the occurrence in this app only — Calendar still has it. Returns
 * false when the key is not a known feed occurrence.
 */
export function hideOccurrence(key: string): boolean {
  const conn = db();
  const exists = conn.prepare("SELECT 1 FROM ics_events WHERE key = ?").get(key);
  if (!exists) return false;
  const hide = conn.transaction(() => {
    conn
      .prepare("INSERT OR REPLACE INTO hidden_occurrences (key, created_at) VALUES (?, ?)")
      .run(key, nowIso());
    conn.prepare("DELETE FROM completions WHERE occurrence_key = ?").run(key);
    conn.prepare("DELETE FROM board_order WHERE item_key = ?").run(key);
  });
  hide();
  return true;
}

export function deleteLocalEvent(id: string): void {
  const conn = db();
  const row = conn
    .prepare("SELECT detached_from_key AS key FROM local_events WHERE id = ?")
    .get(id) as { key: string | null } | undefined;

  const remove = conn.transaction(() => {
    conn.prepare("DELETE FROM local_events WHERE id = ?").run(id);
    conn.prepare("DELETE FROM completions WHERE occurrence_key = ?").run(`local:${id}`);
    conn.prepare("DELETE FROM board_order WHERE item_key = ?").run(`local:${id}`);
    conn.prepare("DELETE FROM item_notes WHERE item_key = ?").run(`local:${id}`);
    // Deleting a detached copy restores the feed original it was hiding.
    if (row?.key) conn.prepare("DELETE FROM hidden_occurrences WHERE key = ?").run(row.key);
  });
  remove();
}

/**
 * Move an event to a new day, and optionally a new start time.
 *
 * Local events move in place. A feed event cannot be edited (and must never
 * be written back), so dragging one detaches a local copy at the new slot and
 * hides the original — the user's chosen behaviour.
 *
 * `newLocalId` names that copy — the phone mints it so it can refer to the
 * copy before the Mac has made it. Ignored when nothing is detached.
 */
export function moveOccurrence(
  key: string,
  toYmd: string,
  toStartMin?: number | null,
  newLocalId?: string,
): { key: string } {
  const conn = db();
  const retime = toStartMin !== undefined && toStartMin !== null;

  if (key.startsWith("local:")) {
    const id = key.slice("local:".length);
    const row = conn
      .prepare(
        `SELECT ymd, end_ymd AS endYmd, start_min AS startMin, end_min AS endMin, all_day AS allDay
           FROM local_events WHERE id = ?`,
      )
      .get(id) as
      | { ymd: string; endYmd: string; startMin: number | null; endMin: number | null; allDay: number }
      | undefined;
    if (!row) throw new Error("Event not found");
    const span = Math.max(0, daysApart(row.ymd, row.endYmd));

    if (retime) {
      const duration = durationOf(row.startMin, row.endMin);
      conn
        .prepare(
          `UPDATE local_events
              SET ymd = ?, end_ymd = ?, start_min = ?, end_min = ?, all_day = 0
            WHERE id = ?`,
        )
        .run(toYmd, addDays(toYmd, span), toStartMin, toStartMin! + duration, id);
    } else {
      conn
        .prepare("UPDATE local_events SET ymd = ?, end_ymd = ? WHERE id = ?")
        .run(toYmd, addDays(toYmd, span), id);
    }
    conn.prepare("UPDATE completions SET ymd = ? WHERE occurrence_key = ?").run(toYmd, key);
    return { key };
  }

  // This feed occurrence may already have been detached — a drag replayed
  // from a tab still holding the old key, or a second drag before the refetch
  // landed. Move the copy that exists instead of making another one; the
  // original is hidden either way, so a duplicate is invisible until it turns
  // up on the phone as a second reminder.
  const detachedId = conn
    .prepare("SELECT id FROM local_events WHERE detached_from_key = ? LIMIT 1")
    .get(key) as { id: string } | undefined;
  if (detachedId) {
    const moved = moveOccurrence(`local:${detachedId.id}`, toYmd, toStartMin);
    return moved;
  }

  const source = conn
    .prepare(
      `SELECT calendar_id AS calendarId, title, ymd, start_min AS startMin,
              end_ymd AS endYmd, end_min AS endMin, all_day AS allDay, notes
         FROM ics_events WHERE key = ?`,
    )
    .get(key) as
    | {
        calendarId: string;
        title: string;
        ymd: string;
        startMin: number | null;
        endYmd: string;
        endMin: number | null;
        allDay: number;
        notes: string | null;
      }
    | undefined;
  if (!source) throw new Error("Event not found");

  const span = Math.max(0, daysApart(source.ymd, source.endYmd));
  const duration = durationOf(source.startMin, source.endMin);
  let newId = "";
  const detach = conn.transaction(() => {
    newId = createLocalEvent({
      title: source.title,
      ymd: toYmd,
      calendarId: source.calendarId,
      startMin: retime ? toStartMin : source.startMin,
      endMin: retime ? toStartMin! + duration : source.endMin,
      endYmd: addDays(toYmd, span),
      allDay: retime ? false : !!source.allDay,
      notes: source.notes,
      detachedFromKey: key,
      id: newLocalId,
    });
    conn
      .prepare("INSERT OR REPLACE INTO hidden_occurrences (key, created_at) VALUES (?, ?)")
      .run(key, nowIso());
    // Carry a tick across to the detached copy so progress is not lost.
    conn
      .prepare("UPDATE completions SET occurrence_key = ?, ymd = ? WHERE occurrence_key = ?")
      .run(`local:${newId}`, toYmd, key);
  });
  detach();
  // The key has changed: carry the note here rather than at each call site.
  relinkNote(key, `local:${newId}`);

  return { key: `local:${newId}` };
}


/** Length of an event in minutes, defaulting to an hour when it has no end. */
function durationOf(startMin: number | null, endMin: number | null): number {
  if (startMin === null || endMin === null) return 60;
  return Math.max(15, endMin - startMin);
}

function daysApart(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/* ---------------------------------------------------------------- completions */

/**
 * Tick or untick an event. Any event can be ticked — the to-do board treats
 * meetings and appointments as work items too — but only events matching a
 * habit carry a habit_id, and only those move habit progress. Ticking is still
 * the sole way a habit gets credited; there is no habit-level logging path.
 */
export function setCompletion(occurrenceKey: string, completed: boolean): void {
  const conn = db();
  if (!completed) {
    conn.prepare("DELETE FROM completions WHERE occurrence_key = ?").run(occurrenceKey);
    return;
  }

  const habits = listHabits();
  let row: { title: string; ymd: string; calendarId: string | null } | undefined;

  if (occurrenceKey.startsWith("local:")) {
    row = conn
      .prepare("SELECT title, ymd, calendar_id AS calendarId FROM local_events WHERE id = ?")
      .get(occurrenceKey.slice("local:".length)) as typeof row;
  } else {
    row = conn
      .prepare("SELECT title, ymd, calendar_id AS calendarId FROM ics_events WHERE key = ?")
      .get(occurrenceKey) as typeof row;
  }
  if (!row) throw new Error("Event not found");

  const habit = matchHabit(habits, row.title, row.calendarId);

  conn
    .prepare(
      `INSERT INTO completions (occurrence_key, habit_id, ymd, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(occurrence_key) DO UPDATE SET habit_id = excluded.habit_id, ymd = excluded.ymd`,
    )
    .run(occurrenceKey, habit?.id ?? null, row.ymd, nowIso());
}

/* ------------------------------------------------------------------ progress */

/**
 * Score one week's tally against a habit's target.
 *
 * Shared with the streak matrix so the sidebar and /streaks can never disagree
 * about whether a week counted.
 */
export function scoreWeek(
  habit: Pick<HabitRecord, "targetType" | "targetCount">,
  tally: { total: number; distinctDays: number },
  /** Days of the week spent away (see lib/pauses): the target shrinks to fit. */
  pausedDays = 0,
): { done: number; target: number; met: boolean; paused: boolean } {
  const home = Math.max(0, 7 - pausedDays);
  let done: number;
  let target: number;
  if (habit.targetType === "times_per_week") {
    done = tally.total;
    target = Math.round((habit.targetCount * home) / 7);
  } else if (habit.targetType === "days_per_week") {
    done = tally.distinctDays;
    target = Math.round((habit.targetCount * home) / 7);
  } else {
    done = tally.distinctDays;
    target = home;
  }
  // A week away — or so nearly away that the target rounds to nothing — is
  // not scored at all: streaks step over it, and it is never "perfect" or
  // "missed". Anything done in it still shows.
  const paused = pausedDays > 0 && target === 0;
  return { done, target, met: target > 0 && done >= target, paused };
}

/**
 * Weekly progress for each habit.
 *
 * Counted from `completions`, which is the one place every kind of credit
 * lands: a ticked event, a ticked to-do whose title matches, and a reading the
 * importer turned into a tick. Counting matching occurrences instead — as this
 * used to — meant a ticked to-do moved the streak matrix but not this number,
 * and that disabling a calendar quietly erased past progress.
 */
export function getHabitProgress(anchorYmd: string = todayYmd()): HabitProgress[] {
  const conn = db();
  const habits = listHabits();
  if (!habits.length) return [];

  const weekStart = startOfWeek(anchorYmd);
  const weekEnd = endOfWeek(anchorYmd);
  const pauses = listPauses(true);
  const pausedDays = pausedDaysInWeek(pauses, weekStart);

  const tallies = new Map<string, { total: number; days: Set<string> }>();
  for (const row of conn
    .prepare(
      `SELECT habit_id AS habitId, ymd FROM completions
        WHERE habit_id IS NOT NULL AND ymd BETWEEN ? AND ?`,
    )
    .all(weekStart, weekEnd) as { habitId: string; ymd: string }[]) {
    let tally = tallies.get(row.habitId);
    if (!tally) tallies.set(row.habitId, (tally = { total: 0, days: new Set() }));
    tally.total += 1;
    tally.days.add(row.ymd);
  }

  // Still ahead of you this week: matching events and to-dos not yet ticked.
  const occurrences = getOccurrences(weekStart, weekEnd);
  const openTasks = listTasks(weekStart, weekEnd).filter((t) => !t.done && t.ymd >= weekStart);

  return habits.map((habit) => {
    const tally = tallies.get(habit.id);
    const { done, target } = scoreWeek(
      habit,
      { total: tally?.total ?? 0, distinctDays: tally?.days.size ?? 0 },
      pausedDays,
    );

    // A reading either arrives or it does not — nothing about it is "planned".
    const planned = habit.metricKind
      ? 0
      : occurrences.filter((o) => o.habitId === habit.id && !o.completed).length +
        openTasks.filter((t) => habitForTask(habits, t.title)?.id === habit.id).length;

    return {
      habit,
      done,
      target,
      planned,
      pausedDays,
      streak: weeklyStreak(conn, habit, anchorYmd, pauses),
    };
  });
}

/**
 * Consecutive weeks the habit met its target, ending at the last complete week.
 *
 * Weeks, not days: a three-times-a-week habit has no meaningful run of
 * consecutive days, and counting them made the sidebar read "1-day streak" for
 * ever. The week in progress is excluded, exactly as on /streaks, so the number
 * only moves when a week actually finishes.
 */
function weeklyStreak(
  conn: ReturnType<typeof db>,
  habit: HabitRecord,
  today: string,
  pauses: PauseRecord[] = [],
): number {
  const rows = conn
    .prepare("SELECT ymd FROM completions WHERE habit_id = ? AND ymd <= ? ORDER BY ymd")
    .all(habit.id, today) as { ymd: string }[];
  if (!rows.length) return 0;

  const weeks = new Map<string, { total: number; days: Set<string> }>();
  for (const row of rows) {
    const start = startOfWeek(row.ymd);
    let tally = weeks.get(start);
    if (!tally) weeks.set(start, (tally = { total: 0, days: new Set() }));
    tally.total += 1;
    tally.days.add(row.ymd);
  }

  const earliest = startOfWeek(rows[0].ymd);
  let cursor = addDays(startOfWeek(today), -7);
  let streak = 0;
  while (cursor >= earliest) {
    const tally = weeks.get(cursor);
    const { met, paused } = scoreWeek(
      habit,
      { total: tally?.total ?? 0, distinctDays: tally?.days.size ?? 0 },
      pausedDaysInWeek(pauses, cursor),
    );
    cursor = addDays(cursor, -7);
    // A week away neither breaks the run nor lengthens it.
    if (paused) continue;
    if (!met) break;
    streak += 1;
  }
  return streak;
}

/**
 * Distinct event titles in the cached window, so the habit form can show how
 * many events a typed title would actually match before it is saved.
 */
export function titleSuggestions(calendarId: string | null): { title: string; count: number }[] {
  const conn = db();
  const rows = (
    calendarId
      ? conn
          .prepare(
            `SELECT title, COUNT(*) AS count FROM ics_events WHERE calendar_id = ?
              GROUP BY title ORDER BY count DESC, title LIMIT 200`,
          )
          .all(calendarId)
      : conn
          .prepare(
            `SELECT title, COUNT(*) AS count FROM ics_events
              GROUP BY title ORDER BY count DESC, title LIMIT 200`,
          )
          .all()
  ) as { title: string; count: number }[];
  return rows;
}

/* --------------------------------------------------------------------- tasks */

export type TaskRecord = {
  id: string;
  ymd: string;
  title: string;
  done: boolean;
  position: number;
  /** Minutes past midnight, or null for an untimed to-do. */
  startMin: number | null;
};

type TaskRow = Omit<TaskRecord, "done"> & { done: number };

/**
 * Tasks in a date range, plus any unfinished task from before it.
 *
 * The board window rolls forward daily, so without the carry-over an undone
 * task would silently scroll out of reach. Carried tasks surface in the first
 * column, still carrying their original date.
 */
export function listTasks(fromYmd: string, toYmd: string): TaskRecord[] {
  const rows = db()
    .prepare(
      `SELECT id, ymd, title, done, position, start_min AS startMin FROM tasks
        WHERE (ymd BETWEEN @from AND @to)
           OR (ymd < @from AND done = 0)
        ORDER BY ymd, position, rowid`,
    )
    .all({ from: fromYmd, to: toYmd }) as TaskRow[];
  return rows.map((r) => ({ ...r, done: !!r.done }));
}

/** One to-do by id, whatever its day or state; null when there is no such to-do. */
export function getTask(id: string): TaskRecord | null {
  const row = db()
    .prepare("SELECT id, ymd, title, done, position, start_min AS startMin FROM tasks WHERE id = ?")
    .get(id) as TaskRow | undefined;
  return row ? { ...row, done: !!row.done } : null;
}

export function createTask(input: {
  ymd: string;
  title: string;
  startMin?: number | null;
  /** Insert-if-absent, as in createCalendar. */
  id?: string;
}): TaskRecord {
  const existing = input.id ? getTask(input.id) : null;
  if (existing) return existing;
  const conn = db();
  const max = conn
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE ymd = ?")
    .get(input.ymd) as { p: number };
  const id = input.id ?? newId();
  const startMin = input.startMin ?? null;
  conn
    .prepare(
      `INSERT INTO tasks (id, ymd, title, done, position, start_min, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, input.ymd, input.title.trim(), max.p + 1, startMin, nowIso());
  return {
    id,
    ymd: input.ymd,
    title: input.title.trim(),
    done: false,
    position: max.p + 1,
    startMin,
  };
}

/**
 * Keep a to-do's completion row in step with the to-do itself.
 *
 * A ticked to-do whose title matches a habit credits that habit exactly as a
 * ticked event does — same table, same shape — so weekly progress, the streak
 * matrix and everything downstream pick it up with no special cases. Derived
 * from the task's current state rather than from the patch, so re-titling,
 * moving days and unticking all settle correctly.
 */
function syncTaskCompletion(conn: ReturnType<typeof db>, id: string): void {
  const task = conn
    .prepare("SELECT ymd, title, done FROM tasks WHERE id = ?")
    .get(id) as { ymd: string; title: string; done: number } | undefined;
  const key = taskCompletionKey(id);
  if (!task || !task.done) {
    conn.prepare("DELETE FROM completions WHERE occurrence_key = ?").run(key);
    return;
  }
  const habit = habitForTask(listHabits(), task.title);
  conn
    .prepare(
      `INSERT INTO completions (occurrence_key, habit_id, ymd, created_at)
       VALUES (?, ?, ?, ?)
         ON CONFLICT(occurrence_key) DO UPDATE SET
           habit_id = excluded.habit_id, ymd = excluded.ymd`,
    )
    .run(key, habit?.id ?? null, task.ymd, nowIso());
}

/** Completion key for a to-do. Distinct from occurrence and metric: keys. */
export function taskCompletionKey(id: string): string {
  return `task:${id}`;
}

export function updateTask(
  id: string,
  patch: { title?: string; done?: boolean; ymd?: string; startMin?: number | null },
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.title !== undefined) {
    sets.push("title = @title");
    params.title = patch.title.trim();
  }
  if (patch.ymd !== undefined) {
    sets.push("ymd = @ymd");
    params.ymd = patch.ymd;
  }
  if (patch.done !== undefined) {
    sets.push("done = @done");
    params.done = patch.done ? 1 : 0;
  }
  if (patch.startMin !== undefined) {
    sets.push("start_min = @startMin");
    params.startMin = patch.startMin;
  }
  if (!sets.length) return;
  const conn = db();
  conn.transaction(() => {
    conn.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
    // Title, day and done state all feed the completion row, so re-derive it
    // whenever any of them moves.
    if (patch.done !== undefined || patch.title !== undefined || patch.ymd !== undefined) {
      syncTaskCompletion(conn, id);
    }
  })();
}

export function deleteTask(id: string): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    // Its hand-set position would otherwise sit in board_order for ever.
    conn.prepare("DELETE FROM board_order WHERE item_key = ?").run(`task:${id}`);
    // Deleting the to-do withdraws the habit credit it was carrying.
    conn.prepare("DELETE FROM completions WHERE occurrence_key = ?").run(taskCompletionKey(id));
    // A "travel …" to-do that opened a pause takes the pause with it.
    conn.prepare("DELETE FROM pauses WHERE origin_key = ? AND source = 'board'").run(`task:${id}`);
    // Its notes go too; nothing renders them once the to-do is gone.
    conn.prepare("DELETE FROM item_notes WHERE item_key = ?").run(`task:${id}`);
  })();
}

/* ------------------------------------------------------- need-to-action list */

export type ActionRecord = {
  id: string;
  title: string;
  done: boolean;
  position: number;
};

type ActionRow = Omit<ActionRecord, "done"> & { done: number };

/** The undated backlog, open items first so finished ones sink out of the way. */
export function listActions(): ActionRecord[] {
  const rows = db()
    .prepare("SELECT id, title, done, position FROM action_items ORDER BY done, position, rowid")
    .all() as ActionRow[];
  return rows.map((r) => ({ ...r, done: !!r.done }));
}

/** `id`: insert-if-absent, as in createCalendar. */
export function createAction(title: string, id?: string): ActionRecord {
  const conn = db();
  if (id) {
    const row = conn
      .prepare("SELECT id, title, done, position FROM action_items WHERE id = ?")
      .get(id) as ActionRow | undefined;
    if (row) return { ...row, done: !!row.done };
  }
  const max = conn
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM action_items")
    .get() as { p: number };
  const actionId = id ?? newId();
  const position = max.p + 1;
  conn
    .prepare(
      "INSERT INTO action_items (id, title, done, position, created_at) VALUES (?, ?, 0, ?, ?)",
    )
    .run(actionId, title.trim(), position, nowIso());
  return { id: actionId, title: title.trim(), done: false, position };
}

export function updateAction(id: string, patch: { title?: string; done?: boolean }): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.title !== undefined) {
    sets.push("title = @title");
    params.title = patch.title.trim();
  }
  if (patch.done !== undefined) {
    sets.push("done = @done");
    params.done = patch.done ? 1 : 0;
  }
  if (!sets.length) return;
  db().prepare(`UPDATE action_items SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function deleteAction(id: string): void {
  db().prepare("DELETE FROM action_items WHERE id = ?").run(id);
}

/**
 * Where a backlog item was dropped. The sidebar sends the rows either side of
 * the gap; the phone's offline queue predates that and replays a bare index.
 */
export type ActionMoveTarget =
  | { beforeId: string | null; afterId: string | null }
  | { index: number };

/**
 * Reorder the backlog, renumbering from zero so positions stay dense.
 *
 * False when the row is gone, or when both the rows it was dropped between are:
 * the list moved on under the open tab (a reminder ticked on the phone deletes
 * one), and an ordinal counted against its stale copy would land the item
 * somewhere nobody dropped it.
 */
/**
 * Put these backlog items in this order, in the slots they already occupy, so
 * every other item stays where it is. For the Reminders mirror: the list was
 * dragged into a new order on the phone. Ids no longer here are skipped.
 */
export function reorderActions(ids: string[]): void {
  const conn = db();
  conn.transaction(() => {
    const all = (
      conn.prepare("SELECT id FROM action_items ORDER BY done, position, rowid").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    const present = new Set(all);
    const wanted = ids.filter((id) => present.has(id));
    const wantedSet = new Set(wanted);
    let next = 0;
    const order = all.map((id) => (wantedSet.has(id) ? wanted[next++] : id));
    if (order.every((id, i) => id === all[i])) return;
    const setPosition = conn.prepare("UPDATE action_items SET position = ? WHERE id = ?");
    order.forEach((id, i) => setPosition.run(i, id));
  })();
}

export function moveAction(id: string, target: ActionMoveTarget): boolean {
  const conn = db();
  let moved = false;
  conn.transaction(() => {
    const all = (
      conn.prepare("SELECT id FROM action_items ORDER BY done, position, rowid").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    if (!all.includes(id)) return;
    const ids = all.filter((other) => other !== id);
    const index =
      "index" in target
        ? Math.max(0, Math.min(target.index, ids.length))
        : indexForNeighbours(ids, target.beforeId, target.afterId);
    if (index === null) return;
    ids.splice(index, 0, id);
    const setPosition = conn.prepare("UPDATE action_items SET position = ? WHERE id = ?");
    ids.forEach((other, i) => setPosition.run(i, other));
    moved = true;
  })();
  return moved;
}

