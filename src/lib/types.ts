export type CalendarSourceKind = "ics" | "caldav";

export type CalendarRecord = {
  id: string;
  name: string;
  color: string;
  kind: CalendarSourceKind;
  url: string;
  enabled: boolean;
  position: number;
};

/**
 * A single dated thing on the grid, already normalised to APP_TZ wall-clock.
 * `ics` occurrences are read-only mirrors of iCloud; `local` ones live only in
 * this app and are never written back to iCloud.
 */
export type Occurrence = {
  /** Stable across syncs: `${calendarId}:${uid}:${recurrenceId ?? startYmd}` for ICS. */
  key: string;
  origin: "ics" | "local";
  calendarId: string | null;
  title: string;
  ymd: string;
  startMin: number | null;
  endYmd: string;
  endMin: number | null;
  allDay: boolean;
  notes: string | null;
  /** Set on a local event created by dragging a feed event off its slot. */
  detachedFromKey: string | null;
  /** Populated by the habit layer, not by storage. */
  habitId: string | null;
  habitName: string | null;
  habitColor: string | null;
  completed: boolean;
};

export type TargetType = "times_per_week" | "days_per_week" | "every_day";

export type MatchMode = "exact" | "contains";

export type HabitRecord = {
  id: string;
  name: string;
  /** Event title to match on. Defaults to the habit name. */
  matchTitle: string;
  matchMode: MatchMode;
  /** null = match across every calendar. */
  calendarId: string | null;
  targetType: TargetType;
  targetCount: number;
  color: string;
  archived: boolean;
  position: number;
  /**
   * Set when the habit is driven by a daily reading (e.g. "steps") rather than
   * by ticking events. Such a habit never matches a calendar title and never
   * appears on the board — it ticks itself from the data.
   */
  metricKind: string | null;
  metricThreshold: number | null;
  /**
   * When the habit started counting (YYYY-MM-DD, or an ISO timestamp on rows
   * written before this was a date). Its week is the first that may require
   * the habit for a perfect score; earlier weeks ignore it entirely.
   */
  createdAt: string;
};

export type HabitProgress = {
  habit: HabitRecord;
  /** Completions inside the current week (or today, for every_day). */
  done: number;
  target: number;
  /** Matching events in the window that have not been ticked. */
  planned: number;
  /** Days of this week spent away; the target above already allows for them. */
  pausedDays: number;
  /** Consecutive finished weeks that met the target (weeks away are skipped). */
  streak: number;
};

export type SyncStatus = {
  calendarId: string;
  calendarName: string;
  lastSyncAt: string | null;
  lastStatus: "ok" | "error" | "never";
  lastError: string | null;
  eventCount: number;
};
