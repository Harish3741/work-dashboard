import { db } from "./db.js";
import { listHabits, scoreWeek } from "./store.js";
import { listPauses, pausedDaysInWeek } from "./pauses.js";
import { addDays, startOfWeek, todayYmd } from "./time.js";
import type { HabitRecord } from "./types.js";

/**
 * A year of weekly habit results, as a habit × week matrix.
 *
 * Derived from the `completions` table rather than from expanded occurrences.
 * That matters: the occurrence cache only spans a window around today, so
 * anything built on it would silently go blank for older weeks. Completions are
 * durable and carry both habit_id and ymd, which is everything this needs.
 *
 * Targets are not versioned, so a habit's *current* target is applied to every
 * past week. Raising a target therefore re-scores history. Versioning targets
 * would fix that and is deliberately not done here — the UI says so instead.
 */

export type WeekResult = {
  /** Monday of the week. */
  start: string;
  done: number;
  target: number;
  met: boolean;
  /** Later than the current week — nothing could have happened yet. */
  future: boolean;
  /**
   * The habit existed this week, so it counted towards a perfect score. False
   * for weeks before it was added: those are scored as if it were not there.
   */
  active: boolean;
  /**
   * The week was spent away (see lib/pauses): not required, not scored.
   * Streaks step over it; it is neither perfect nor missed.
   */
  paused: boolean;
};

export type HabitStreakRow = {
  habit: HabitRecord;
  weeks: WeekResult[];
  /** Consecutive met weeks ending at the most recent complete week. */
  runningStreak: number;
  metWeeks: number;
};

export type StreakMatrix = {
  year: number;
  /** Monday of each week, oldest first. */
  weekStarts: string[];
  /** Parallel to weekStarts: weeks that have not happened yet. */
  future: boolean[];
  rows: HabitStreakRow[];
  /** Weeks where every habit met its target. */
  perfectWeeks: boolean[];
  perfectCount: number;
  /** Weeks with at least one completion — the honest denominator. */
  activeWeeks: number;
};

/**
 * Every Monday-start week touching the calendar year.
 *
 * The first week is the one containing 1 January, so it may begin in the
 * previous December; likewise the last week may run into January. A calendar
 * year is what the view promises, and weeks do not divide into it evenly.
 */
function weekStartsForYear(year: number): string[] {
  const first = startOfWeek(`${year}-01-01`);
  const last = startOfWeek(`${year}-12-31`);
  const out: string[] = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 7)) out.push(cursor);
  return out;
}

type CompletionRow = { habitId: string; ymd: string };

export function buildStreakMatrix(
  year: number = Number(todayYmd().slice(0, 4)),
  today: string = todayYmd(),
): StreakMatrix {
  const habits = listHabits().filter((h) => !h.archived);
  const pauses = listPauses(true);
  const weekStarts = weekStartsForYear(year);
  const currentWeek = startOfWeek(today);
  const future = weekStarts.map((start) => start > currentWeek);
  const from = weekStarts[0];
  const to = addDays(weekStarts[weekStarts.length - 1], 6);

  const rowsRaw = db()
    .prepare(
      `SELECT habit_id AS habitId, ymd FROM completions
        WHERE habit_id IS NOT NULL AND ymd BETWEEN ? AND ?`,
    )
    .all(from, to) as CompletionRow[];

  // habitId -> weekStart -> ymds completed
  const byHabitWeek = new Map<string, Map<string, Set<string>>>();
  const counts = new Map<string, Map<string, number>>();
  for (const row of rowsRaw) {
    const weekStart = startOfWeek(row.ymd);
    let days = byHabitWeek.get(row.habitId);
    if (!days) byHabitWeek.set(row.habitId, (days = new Map()));
    let set = days.get(weekStart);
    if (!set) days.set(weekStart, (set = new Set()));
    set.add(row.ymd);

    let tally = counts.get(row.habitId);
    if (!tally) counts.set(row.habitId, (tally = new Map()));
    tally.set(weekStart, (tally.get(weekStart) ?? 0) + 1);
  }

  const rows: HabitStreakRow[] = habits.map((habit) => {
    // Everything from the week the habit was added onwards. A habit created
    // mid-week counts for that whole week: it is the week you started, and
    // part-scoring it would just be an arbitrary handicap.
    //
    // A row written straight into SQLite has no start date until the migration
    // backfills it on the next open. Count it in every week until then: that is
    // the old behaviour, and it can only ever be too strict, never too lenient.
    const startWeek = habit.createdAt ? startOfWeek(habit.createdAt.slice(0, 10)) : null;

    const weekResults = weekStarts.map((start) => {
      const distinctDays = byHabitWeek.get(habit.id)?.get(start)?.size ?? 0;
      const total = counts.get(habit.id)?.get(start) ?? 0;
      const { done, target, met, paused } = scoreWeek(
        habit,
        { total, distinctDays },
        pausedDaysInWeek(pauses, start),
      );
      return {
        start,
        done,
        target,
        met,
        future: start > currentWeek,
        active: startWeek === null || start >= startWeek,
        paused,
      };
    });

    // Count back from the last week that has actually finished. The current
    // week is still in progress and weeks beyond it have not happened, so
    // neither may break a streak.
    const lastComplete = weekStarts.findIndex((start) => start >= currentWeek);
    let runningStreak = 0;
    for (let i = (lastComplete === -1 ? weekResults.length : lastComplete) - 1; i >= 0; i--) {
      // Running out of history ends the run; it does not break it.
      if (!weekResults[i].active) break;
      // A week away is stepped over: it neither breaks the run nor adds to it.
      if (weekResults[i].paused) continue;
      if (!weekResults[i].met) break;
      runningStreak += 1;
    }

    return {
      habit,
      weeks: weekResults,
      runningStreak,
      metWeeks: weekResults.filter((w) => w.met && w.active).length,
    };
  });

  const anyActivity = weekStarts.map((start) =>
    rows.some((r) => (r.weeks.find((w) => w.start === start)?.done ?? 0) > 0),
  );

  const perfectWeeks = weekStarts.map((start, i) => {
    if (rows.length === 0) return false;
    // A week with no habit activity at all is not "perfect", it is empty.
    if (!anyActivity[i]) return false;
    // Only habits that existed that week are required, and a week away is
    // not required of anyone. Adding a habit today therefore cannot turn a
    // year of finished weeks into failures, and neither can a holiday.
    return rows.every((r) => !r.weeks[i].active || r.weeks[i].paused || r.weeks[i].met);
  });

  return {
    year,
    future,
    weekStarts,
    rows,
    perfectWeeks,
    perfectCount: perfectWeeks.filter(Boolean).length,
    activeWeeks: anyActivity.filter(Boolean).length,
  };
}
