import { db, nowIso } from "./db.js";
import { addMonths, startOfMonth, todayYmd, addDays } from "./time.js";
import type { CalendarRecord, SyncStatus } from "./types.js";
import { IcsCalendarSource } from "./calendar/ics.js";
import type { CalendarSource, FetchWindow } from "./calendar/source.js";
import { listCalendars } from "./store.js";
import { noteChange } from "./changes.js";

/** How far either side of today we keep expanded occurrences cached. */
const WINDOW_MONTHS_BACK = 6;
const WINDOW_MONTHS_FORWARD = 12;

const sources: Record<string, CalendarSource> = {
  ics: new IcsCalendarSource(),
};

export function syncWindow(): FetchWindow {
  const today = todayYmd();
  return {
    fromYmd: startOfMonth(addMonths(today, -WINDOW_MONTHS_BACK)),
    toYmd: addDays(startOfMonth(addMonths(today, WINDOW_MONTHS_FORWARD + 1)), -1),
  };
}

export type CalendarSyncResult = {
  calendarId: string;
  calendarName: string;
  ok: boolean;
  count: number;
  error?: string;
};

async function syncCalendar(
  calendar: CalendarRecord,
  window: FetchWindow,
): Promise<CalendarSyncResult> {
  const conn = db();
  const source = sources[calendar.kind];

  try {
    if (!source) throw new Error(`Unknown calendar kind "${calendar.kind}"`);
    const occurrences = await source.fetchOccurrences(calendar, window);

    // Replace this calendar's cache atomically: a failed fetch must never
    // leave the grid half-empty, and completions key off occurrence keys that
    // stay stable across the swap.
    const replace = conn.transaction(() => {
      conn.prepare("DELETE FROM ics_events WHERE calendar_id = ?").run(calendar.id);
      const insert = conn.prepare(
        `INSERT OR REPLACE INTO ics_events
           (key, calendar_id, uid, recurrence_id, title, ymd, start_min, end_ymd, end_min, all_day, notes,
            conference_url, attendees)
         VALUES (@key, @calendarId, @uid, @recurrenceId, @title, @ymd, @startMin, @endYmd, @endMin, @allDay, @notes,
                 @conferenceUrl, @attendees)`,
      );
      for (const occ of occurrences) {
        insert.run({
          key: occurrenceKey(calendar.id, occ.uid, occ.recurrenceId),
          calendarId: calendar.id,
          uid: occ.uid,
          recurrenceId: occ.recurrenceId,
          title: occ.title,
          ymd: occ.ymd,
          startMin: occ.startMin,
          endYmd: occ.endYmd,
          endMin: occ.endMin,
          allDay: occ.allDay ? 1 : 0,
          notes: occ.notes,
          conferenceUrl: occ.conferenceUrl ?? null,
          attendees: occ.attendees?.length ? JSON.stringify(occ.attendees) : null,
        });
      }
    });
    replace();

    // Adopt the provider's own colour so the app's swatches match what the
    // user sees in Calendar. Only when it actually differs, so this is a no-op
    // on every sync after the first.
    const meta = source.fetchMeta?.(calendar) ?? null;
    if (meta?.color && meta.color !== calendar.color) {
      conn.prepare("UPDATE calendars SET color = ? WHERE id = ?").run(meta.color, calendar.id);
    }

    conn
      .prepare(
        `INSERT INTO sync_state (calendar_id, last_sync_at, last_status, last_error)
         VALUES (?, ?, 'ok', NULL)
         ON CONFLICT(calendar_id) DO UPDATE SET
           last_sync_at = excluded.last_sync_at, last_status = 'ok', last_error = NULL`,
      )
      .run(calendar.id, nowIso());

    return {
      calendarId: calendar.id,
      calendarName: calendar.name,
      ok: true,
      count: occurrences.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    conn
      .prepare(
        `INSERT INTO sync_state (calendar_id, last_sync_at, last_status, last_error)
         VALUES (?, ?, 'error', ?)
         ON CONFLICT(calendar_id) DO UPDATE SET
           last_sync_at = excluded.last_sync_at, last_status = 'error', last_error = excluded.last_error`,
      )
      .run(calendar.id, nowIso(), message);
    return {
      calendarId: calendar.id,
      calendarName: calendar.name,
      ok: false,
      count: 0,
      error: message,
    };
  }
}

/** Occurrence keys must be stable across syncs — completions reference them. */
export function occurrenceKey(
  calendarId: string,
  uid: string,
  recurrenceId: string | null,
): string {
  return recurrenceId ? `${calendarId}:${uid}:${recurrenceId}` : `${calendarId}:${uid}`;
}

let inFlight: Promise<CalendarSyncResult[]> | null = null;

/** Sync every enabled calendar. Concurrent callers share one run. */
export function syncAll(): Promise<CalendarSyncResult[]> {
  if (inFlight) return inFlight;
  const window = syncWindow();
  inFlight = (async () => {
    // Every calendar is synced, including hidden ones — `enabled` is a display
    // filter, so toggling one back on shows data immediately without a refetch.
    const results = await Promise.all(listCalendars().map((c) => syncCalendar(c, window)));
    // ics_events is not watched row by row (the sync rewrites it wholesale),
    // so the board hears about a calendar sync once.
    noteChange("calendar");
    return results;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function syncStatus(): SyncStatus[] {
  const conn = db();
  const rows = conn
    .prepare(
      `SELECT c.id                AS calendarId,
              c.name              AS calendarName,
              s.last_sync_at      AS lastSyncAt,
              COALESCE(s.last_status, 'never') AS lastStatus,
              s.last_error        AS lastError,
              (SELECT COUNT(*) FROM ics_events e WHERE e.calendar_id = c.id) AS eventCount
         FROM calendars c
         LEFT JOIN sync_state s ON s.calendar_id = c.id
        ORDER BY c.position, c.name`,
    )
    .all() as SyncStatus[];
  return rows;
}

/**
 * Hourly background refresh of the calendar feeds. Next dev-mode hot reloads
 * would otherwise stack up timers, so the handle is parked on globalThis.
 */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

type SchedulerGlobal = typeof globalThis & { __habitSyncTimer?: NodeJS.Timeout };

/**
 * Was a calendar run healthy? One dead feed is a warning the sidebar shows;
 * every feed failing is the network, worth retrying soon.
 */
export function syncHealthy(results: CalendarSyncResult[]): boolean {
  return !(results.length > 0 && results.every((r) => !r.ok));
}

/** Kept as a named entry point for the routes and the startup hook. */
export function syncAllRecorded(): Promise<CalendarSyncResult[]> {
  return syncAll();
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000];

function syncWithRetry(attempt = 0): void {
  const again = () => {
    if (attempt >= RETRY_DELAYS_MS.length) return;
    setTimeout(() => syncWithRetry(attempt + 1), RETRY_DELAYS_MS[attempt]).unref?.();
  };
  void syncAll()
    .then((results) => {
      if (!syncHealthy(results)) again();
    })
    .catch(again);
}

export function startScheduler() {
  const g = globalThis as SchedulerGlobal;
  if (g.__habitSyncTimer) return;
  g.__habitSyncTimer = setInterval(() => syncWithRetry(), SYNC_INTERVAL_MS);
  // Unref so the timer never holds the process open on its own.
  g.__habitSyncTimer.unref?.();
}
