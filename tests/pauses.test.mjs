import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Time away: a pause shrinks the week's target to the days at home, a week
 * spent away is stepped over by streaks and never counts as missed, and a
 * pending proposal from the inbox changes nothing until approved.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-pauses-"));
process.env.HABIT_DATA_DIR = dataDir;

const pauses = await import("../.test-build/pauses.js");
const { scoreWeek, getHabitProgress, createTask, deleteTask } = await import("../.test-build/store.js");
const { buildStreakMatrix } = await import("../.test-build/streaks.js");
const { db } = await import("../.test-build/db.js");

// 2026-08-16 is a Sunday: this week Mon 08-10..Sun 08-16.
const TODAY = "2026-08-16";
const THIS_WEEK = "2026-08-10";
const LAST_WEEK = "2026-08-03";
const TWO_AGO = "2026-07-27";
const THREE_AGO = "2026-07-20";

beforeEach(() => {
  const conn = db();
  conn.prepare("DELETE FROM completions").run();
  conn.prepare("DELETE FROM habits").run();
  conn.prepare("DELETE FROM pauses").run();
});

function addHabit(id, targetType, targetCount) {
  db()
    .prepare(
      `INSERT INTO habits (id, name, match_title, match_mode, target_type, target_count, color, archived, position)
       VALUES (?, ?, ?, 'exact', ?, ?, '#fff', 0, 0)`,
    )
    .run(id, id, id, targetType, targetCount);
}

function complete(habitId, ymd) {
  db()
    .prepare("INSERT INTO completions (occurrence_key, habit_id, ymd, created_at) VALUES (?, ?, ?, '')")
    .run(`${habitId}:${ymd}`, habitId, ymd);
}

const weekOf = (row, start) => row.weeks.find((w) => w.start === start);

test("scoreWeek shrinks the target to the days at home", () => {
  assert.deepEqual(scoreWeek({ targetType: "every_day", targetCount: 1 }, { total: 4, distinctDays: 4 }, 3), {
    done: 4, target: 4, met: true, paused: false,
  });
  // 3×/week, away 3 days → 3 × 4/7 ≈ 2
  assert.equal(scoreWeek({ targetType: "times_per_week", targetCount: 3 }, { total: 2, distinctDays: 2 }, 3).target, 2);
  // Nothing away → unchanged.
  assert.equal(scoreWeek({ targetType: "days_per_week", targetCount: 5 }, { total: 0, distinctDays: 0 }).target, 5);
});

test("a whole week away is paused, not failed — and still shows what was done", () => {
  const away = scoreWeek({ targetType: "every_day", targetCount: 1 }, { total: 1, distinctDays: 1 }, 7);
  assert.equal(away.paused, true);
  assert.equal(away.met, false);
  assert.equal(away.target, 0);
  assert.equal(away.done, 1);
  // Nearly all away: a target that rounds to nothing is a pause too.
  assert.equal(scoreWeek({ targetType: "times_per_week", targetCount: 1 }, { total: 0, distinctDays: 0 }, 6).paused, true);
  // But a week with no pause at all and a zero target is not "paused".
  assert.equal(scoreWeek({ targetType: "times_per_week", targetCount: 0 }, { total: 0, distinctDays: 0 }).paused, false);
});

test("pausedDaysInWeek clips a pause to the week and merges overlaps", () => {
  const list = [
    { id: "a", fromYmd: "2026-08-08", toYmd: "2026-08-12", label: "", source: "board", pending: false, createdAt: "" },
    { id: "b", fromYmd: "2026-08-12", toYmd: "2026-08-13", label: "", source: "board", pending: false, createdAt: "" },
    { id: "c", fromYmd: "2026-08-14", toYmd: "2026-08-20", label: "", source: "inbox", pending: true, createdAt: "" },
  ];
  assert.equal(pauses.pausedDaysInWeek(list, THIS_WEEK), 4, "10,11,12,13 — pending c does not count");
  assert.equal(pauses.pausedDaysInWeek(list, LAST_WEEK), 2, "8, 9");
  assert.equal(pauses.isPaused(list, "2026-08-11"), true);
  assert.equal(pauses.isPaused(list, "2026-08-15"), false, "pending");
});

test("the sidebar's weekly target allows for days away this week", () => {
  addHabit("h", "every_day", 1);
  pauses.createPause({ fromYmd: "2026-08-13", toYmd: "2026-08-16", label: "Tokyo" });
  complete("h", "2026-08-10");
  complete("h", "2026-08-11");
  complete("h", "2026-08-12");

  const row = getHabitProgress(TODAY).find((p) => p.habit.id === "h");
  assert.equal(row.target, 3, "Mon–Wed at home");
  assert.equal(row.done, 3);
  assert.equal(row.pausedDays, 4);
});

test("a week away is stepped over by the streak, on /streaks and in the sidebar", () => {
  addHabit("h", "times_per_week", 2);
  // three weeks ago met, two weeks ago away, last week met → streak 2
  complete("h", "2026-07-21");
  complete("h", "2026-07-23");
  pauses.createPause({ fromYmd: "2026-07-27", toYmd: "2026-08-02" });
  complete("h", "2026-08-04");
  complete("h", "2026-08-06");

  const m = buildStreakMatrix(2026, TODAY);
  const row = m.rows[0];
  assert.equal(weekOf(row, TWO_AGO).paused, true);
  assert.equal(weekOf(row, TWO_AGO).met, false);
  assert.equal(weekOf(row, THREE_AGO).met, true);
  assert.equal(row.runningStreak, 2, "the week away neither breaks nor extends");
  assert.equal(getHabitProgress(TODAY)[0].streak, 2);
  const i = m.weekStarts.indexOf(TWO_AGO);
  assert.equal(m.perfectWeeks[i], false, "not perfect — nothing was required");
});

test("a pending proposal changes nothing until it is activated", () => {
  addHabit("h", "every_day", 1);
  const p = pauses.createPause({ fromYmd: THIS_WEEK, toYmd: TODAY, source: "inbox", pending: true });
  assert.equal(getHabitProgress(TODAY)[0].target, 7);
  assert.equal(pauses.listPauses(true).length, 0);
  assert.equal(pauses.listPauses().length, 1);

  pauses.activatePause(p.id);
  assert.equal(getHabitProgress(TODAY)[0].target, 0);
  pauses.deletePause(p.id);
  assert.equal(getHabitProgress(TODAY)[0].target, 7);
});

test("currentOrNextPause prefers the one you are in, then the next to start", () => {
  const a = pauses.createPause({ fromYmd: "2026-08-20", toYmd: "2026-08-25" });
  const b = pauses.createPause({ fromYmd: "2026-08-14", toYmd: "2026-08-17" });
  const list = pauses.listPauses();
  assert.equal(pauses.currentOrNextPause(list, TODAY).id, b.id);
  assert.equal(pauses.currentOrNextPause(list, "2026-08-18").id, a.id);
  assert.equal(pauses.currentOrNextPause(list, "2026-08-26"), null);
});

test("a range typed backwards is still a range", () => {
  const p = pauses.createPause({ fromYmd: "2026-08-20", toYmd: "2026-08-10" });
  assert.equal(p.fromYmd, "2026-08-10");
  assert.equal(p.toYmd, "2026-08-20");
});

test("deleting the travel to-do that opened a pause removes the pause", () => {
  const task = createTask({ ymd: "2026-09-12", title: "travel to tokyo", startMin: null });
  pauses.createPause({ fromYmd: "2026-09-12", toYmd: "2026-09-19", label: "travel to tokyo", originKey: `task:${task.id}` });
  const other = pauses.createPause({ fromYmd: "2026-10-01", toYmd: "2026-10-03" });
  assert.equal(pauses.listPauses().length, 2);

  deleteTask(task.id);

  const left = pauses.listPauses();
  assert.equal(left.length, 1);
  assert.equal(left[0].id, other.id, "an unrelated pause is untouched");
});

test("removing a board pause by hand does not blacklist anything", () => {
  const p = pauses.createPause({ fromYmd: "2026-09-12", toYmd: "2026-09-19", originKey: "task:abc" });
  pauses.deletePause(p.id);
  assert.equal(pauses.dismissedOrigins().size, 0);
});
