import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The habit × week matrix, against a throwaway database. HABIT_DATA_DIR is read
 * when db.js is first imported, so the import must be dynamic and come after.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-streaks-"));
process.env.HABIT_DATA_DIR = dataDir;

const { buildStreakMatrix } = await import("../.test-build/streaks.js");
const { db } = await import("../.test-build/db.js");

// 2026-08-16 is a Sunday, so this week runs Mon 2026-08-10 .. Sun 2026-08-16.
const TODAY = "2026-08-16";
const THIS_WEEK = "2026-08-10";
const LAST_WEEK = "2026-08-03";
const TWO_AGO = "2026-07-27";

beforeEach(() => {
  const conn = db();
  conn.prepare("DELETE FROM completions").run();
  conn.prepare("DELETE FROM habits").run();
});

function addHabit(id, name, targetType, targetCount) {
  db()
    .prepare(
      `INSERT INTO habits (id, name, match_title, match_mode, target_type, target_count, color, archived, position)
       VALUES (?, ?, ?, 'exact', ?, ?, '#fff', 0, 0)`,
    )
    .run(id, name, name, targetType, targetCount);
}

function complete(habitId, ymd, n = 1) {
  for (let i = 0; i < n; i++) {
    db()
      .prepare(
        "INSERT INTO completions (occurrence_key, habit_id, ymd, created_at) VALUES (?, ?, ?, '')",
      )
      .run(`${habitId}:${ymd}:${i}`, habitId, ymd);
  }
}

const YEAR = 2026;
const matrix = () => buildStreakMatrix(YEAR, TODAY);
const weekOf = (row, start) => row.weeks.find((w) => w.start === start);

test("times_per_week counts every completion, including two on one day", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  complete("h1", "2026-08-04", 2); // doubled up
  complete("h1", "2026-08-06");

  const m = matrix();
  const week = weekOf(m.rows[0], LAST_WEEK);
  assert.equal(week.done, 3);
  assert.equal(week.met, true);
});

test("days_per_week counts distinct days, so doubling up does not help", () => {
  addHabit("h1", "Gym", "days_per_week", 3);
  complete("h1", "2026-08-04", 3); // all on one day

  const week = weekOf(matrix().rows[0], LAST_WEEK);
  assert.equal(week.done, 1);
  assert.equal(week.met, false);
});

test("every_day needs all seven days", () => {
  addHabit("h1", "Steps", "every_day", 1);
  for (let d = 3; d <= 8; d++) complete("h1", `2026-08-0${d}`); // six days
  let week = weekOf(matrix().rows[0], LAST_WEEK);
  assert.equal(week.target, 7);
  assert.equal(week.met, false);

  complete("h1", "2026-08-09"); // the seventh
  week = weekOf(matrix().rows[0], LAST_WEEK);
  assert.equal(week.met, true);
});

test("a week is perfect only when every habit met its target", () => {
  addHabit("h1", "Gym", "times_per_week", 2);
  addHabit("h2", "Basketball", "times_per_week", 2);
  complete("h1", "2026-08-04", 2);
  complete("h2", "2026-08-05"); // one short

  const m = matrix();
  const i = m.weekStarts.indexOf(LAST_WEEK);
  assert.equal(m.perfectWeeks[i], false);

  complete("h2", "2026-08-06");
  const m2 = matrix();
  assert.equal(m2.perfectWeeks[m2.weekStarts.indexOf(LAST_WEEK)], true);
});

test("an empty week is not perfect — it is just empty", () => {
  addHabit("h1", "Gym", "times_per_week", 2);
  const m = matrix();
  assert.equal(m.perfectCount, 0, "no activity must never read as a perfect run");
  assert.equal(m.activeWeeks, 0);
});

test("completions land in the right week across a Monday boundary", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  complete("h1", "2026-08-09"); // Sunday — belongs to the earlier week
  complete("h1", "2026-08-10"); // Monday — starts a new week

  const row = matrix().rows[0];
  assert.equal(weekOf(row, LAST_WEEK).done, 1);
  assert.equal(weekOf(row, THIS_WEEK).done, 1);
});

test("the in-progress current week cannot break a running streak", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  complete("h1", "2026-07-28");
  complete("h1", "2026-08-04");
  // nothing yet this week

  const row = matrix().rows[0];
  assert.equal(weekOf(row, TWO_AGO).met, true);
  assert.equal(weekOf(row, LAST_WEEK).met, true);
  assert.equal(weekOf(row, THIS_WEEK).met, false);
  assert.equal(row.runningStreak, 2, "today's unfinished week must not zero it");
});

test("archived habits are excluded so they cannot block a perfect week", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  addHabit("h2", "Old thing", "times_per_week", 5);
  db().prepare("UPDATE habits SET archived = 1 WHERE id = 'h2'").run();
  complete("h1", "2026-08-04");

  const m = matrix();
  assert.equal(m.rows.length, 1);
  assert.equal(m.perfectWeeks[m.weekStarts.indexOf(LAST_WEEK)], true);
});


test("the year runs Jan to Dec, oldest first", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  const m = buildStreakMatrix(YEAR, TODAY);

  assert.equal(m.year, YEAR);
  assert.deepEqual([...m.weekStarts].sort(), m.weekStarts, "chronological");
  // The week containing 1 Jan starts in the previous December.
  assert.equal(m.weekStarts[0], "2025-12-29");
  // The last week is the one containing 31 Dec.
  assert.equal(m.weekStarts.at(-1), "2026-12-28");
  assert.equal(m.weekStarts.length, 53);
});

test("weeks after the current one are marked future, not missed", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  const m = buildStreakMatrix(YEAR, TODAY);

  const i = m.weekStarts.indexOf(THIS_WEEK);
  assert.equal(m.future[i], false, "the current week is not the future");
  assert.equal(m.future[i - 1], false, "past weeks are not the future");
  assert.equal(m.future[i + 1], true, "next week is");
  assert.equal(m.future.at(-1), true, "December is");
});

test("empty future weeks never count against the score", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  complete("h1", "2026-08-04");

  const m = buildStreakMatrix(YEAR, TODAY);
  assert.equal(m.perfectCount, 1, "only the one real week counts");
  assert.equal(m.activeWeeks, 1);
  assert.equal(m.perfectWeeks.filter(Boolean).length, 1);
});

test("a streak is not broken by weeks that have not happened yet", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  complete("h1", "2026-07-28");
  complete("h1", "2026-08-04");

  assert.equal(buildStreakMatrix(YEAR, TODAY).rows[0].runningStreak, 2);
});

/*
 * The sidebar's streak. Weeks, not days: a three-times-a-week habit has no
 * meaningful run of consecutive days, and the two views must not disagree.
 */
const { getHabitProgress } = await import("../.test-build/store.js");

const gymStreak = () =>
  getHabitProgress(TODAY).find((p) => p.habit.id === "h1").streak;

test("the streak counts finished weeks that hit the target", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  complete("h1", "2026-07-28", 3); // week of 2026-07-27
  complete("h1", "2026-08-04", 3); // week of 2026-08-03

  assert.equal(gymStreak(), 2);
});

test("a week that fell short ends the streak", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  complete("h1", "2026-07-28", 3);
  complete("h1", "2026-08-04", 2); // one short

  assert.equal(gymStreak(), 0, "the most recent finished week broke it");
});

test("the week in progress neither builds nor breaks the streak", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  complete("h1", "2026-08-04", 3); // last week: met
  assert.equal(gymStreak(), 1);

  complete("h1", "2026-08-10", 3); // this week, also met — but unfinished
  assert.equal(gymStreak(), 1, "it only counts once the week closes");
});

test("the sidebar streak and the matrix agree", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  complete("h1", "2026-07-28", 3);
  complete("h1", "2026-08-04", 3);

  assert.equal(gymStreak(), buildStreakMatrix(YEAR, TODAY).rows[0].runningStreak);
});

test("an every_day habit needs all seven days to extend its streak", () => {
  addHabit("h1", "Steps", "every_day", 1);
  for (let d = 3; d <= 9; d++) complete("h1", `2026-08-0${d}`); // full week
  assert.equal(gymStreak(), 1);

  db().prepare("DELETE FROM completions WHERE ymd = '2026-08-05'").run();
  assert.equal(gymStreak(), 0, "six days is not a week");
});

/*
 * A habit counts from the week it was added. Adding one today must not turn a
 * year of already-scored weeks into failures.
 */
function startHabitOn(id, ymd) {
  db().prepare("UPDATE habits SET created_at = ? WHERE id = ?").run(ymd, id);
}

test("weeks before a habit was added ignore it entirely", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  addHabit("h2", "Steps", "every_day", 1);
  startHabitOn("h1", "2026-07-01");
  startHabitOn("h2", TODAY); // added today
  complete("h1", "2026-08-04"); // last week: Gym met, Steps did not exist

  const m = matrix();
  const i = m.weekStarts.indexOf(LAST_WEEK);
  assert.equal(m.perfectWeeks[i], true, "the new habit must not spoil a finished week");

  const steps = m.rows.find((r) => r.habit.id === "h2");
  assert.equal(steps.weeks[i].active, false, "not required that week");
  assert.equal(steps.weeks[m.weekStarts.indexOf(THIS_WEEK)].active, true, "required from now on");
});

test("from its own week onwards the habit is required", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  addHabit("h2", "Steps", "every_day", 1);
  startHabitOn("h1", "2026-07-01");
  startHabitOn("h2", "2026-08-03"); // added at the start of last week
  complete("h1", "2026-08-04"); // only Gym delivered

  const m = matrix();
  assert.equal(
    m.perfectWeeks[m.weekStarts.indexOf(LAST_WEEK)],
    false,
    "it existed that week, so its miss counts",
  );
});

test("a habit added mid-week counts for that whole week", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  startHabitOn("h1", "2026-08-06"); // a Thursday
  const row = matrix().rows[0];
  assert.equal(weekOf(row, LAST_WEEK).active, true, "the week you start in is a counted week");
  assert.equal(weekOf(row, TWO_AGO).active, false);
});

test("a streak stops at the habit's start rather than being broken by it", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  startHabitOn("h1", LAST_WEEK);
  complete("h1", "2026-08-04");

  const row = matrix().rows[0];
  assert.equal(row.runningStreak, 1, "one met week, and no history before it to break");
});

test("met weeks before the start date are not counted", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  startHabitOn("h1", THIS_WEEK);
  complete("h1", "2026-08-04"); // activity from before it was added

  const row = matrix().rows[0];
  assert.equal(row.metWeeks, 0, "that week was never asked of the habit");
});

test("a habit inserted by hand, with no start date, still counts everywhere", () => {
  addHabit("h1", "Gym", "times_per_week", 1); // helper leaves created_at NULL
  assert.equal(db().prepare("SELECT created_at c FROM habits WHERE id='h1'").get().c, null);

  const row = matrix().rows[0];
  assert.equal(weekOf(row, LAST_WEEK).active, true, "no start date must not blank the year");
});

/*
 * A to-do whose title matches a habit credits it, exactly as a ticked event
 * does. This is the path for habits you do without a calendar entry.
 */
const { createTask, updateTask, deleteTask, getOccurrences } = await import(
  "../.test-build/store.js"
);

function tickedTask(title, ymd = "2026-08-04") {
  const t = createTask({ ymd, title });
  updateTask(t.id, { done: true });
  return t;
}

test("ticking a matching to-do credits the habit", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  tickedTask("Gym");

  const row = matrix().rows[0];
  assert.equal(weekOf(row, LAST_WEEK).done, 1);
  assert.equal(getHabitProgress("2026-08-04").find((p) => p.habit.id === "h1").done, 1);
});

test("unticking it takes the credit back", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  const t = tickedTask("Gym");
  updateTask(t.id, { done: false });

  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 0);
});

test("deleting a ticked to-do takes the credit back", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  const t = tickedTask("Gym");
  deleteTask(t.id);

  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 0);
});

test("a to-do that matches nothing credits nothing", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  tickedTask("Buy milk");

  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 0);
});

test("'contains' matching works for a to-do, as it does for events", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  db().prepare("UPDATE habits SET match_mode='contains' WHERE id='h1'").run();
  tickedTask("Gym (legs)");

  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 1);
});

test("a calendar-scoped habit is still credited by a to-do", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  db()
    .prepare(
      `INSERT OR REPLACE INTO calendars (id,name,color,kind,url,enabled,position)
       VALUES ('cal-gym','Gym cal','#fff','ics','http://x',1,0)`,
    )
    .run();
  db().prepare("UPDATE habits SET calendar_id='cal-gym' WHERE id='h1'").run();
  tickedTask("Gym");

  assert.equal(
    weekOf(matrix().rows[0], LAST_WEEK).done,
    1,
    "scope limits which calendar's events count; a to-do has no calendar",
  );
});

test("a metric habit is never credited by a to-do", () => {
  addHabit("h1", "10k steps", "every_day", 1);
  db().prepare("UPDATE habits SET metric_kind='steps', metric_threshold=10000 WHERE id='h1'").run();
  tickedTask("10k steps");

  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 0, "steps come from the data only");
});

test("re-titling a ticked to-do moves the credit with it", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  const t = tickedTask("Buy milk");
  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 0);

  updateTask(t.id, { title: "Gym" });
  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 1);
});

test("moving a ticked to-do to another day moves its credit", () => {
  addHabit("h1", "Gym", "times_per_week", 1);
  const t = tickedTask("Gym", "2026-08-04");
  assert.equal(weekOf(matrix().rows[0], LAST_WEEK).done, 1);

  updateTask(t.id, { ymd: "2026-08-11" }); // into the current week
  const row = matrix().rows[0];
  assert.equal(weekOf(row, LAST_WEEK).done, 0);
  assert.equal(weekOf(row, THIS_WEEK).done, 1);
});

test("an unticked matching to-do shows as planned", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  createTask({ ymd: "2026-08-11", title: "Gym" });

  const p = getHabitProgress("2026-08-11").find((x) => x.habit.id === "h1");
  assert.equal(p.done, 0);
  assert.equal(p.planned, 1);
});

test("a to-do completion never pretends to be a calendar occurrence", () => {
  addHabit("h1", "Gym", "times_per_week", 3);
  const t = tickedTask("Gym");
  const keys = getOccurrences("2026-08-01", "2026-08-31").map((o) => o.key);
  assert.ok(!keys.includes(`task:${t.id}`), "it is a to-do, not an event");
});
