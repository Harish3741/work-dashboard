import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Notes on a board item, stored against the item key.
 *
 * The key choice is the point: a note on an iCloud occurrence must not detach a
 * local copy of it the way retiming does, and it must still follow the event if
 * something else later does detach it.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-notes-"));
process.env.HABIT_DATA_DIR = dataDir;

const notes = await import("../.test-build/notes.js");
const { buildBoardItems, moveBoardItem, setItemTime, taskKey } = await import(
  "../.test-build/board.js"
);
const store = await import("../.test-build/store.js");
const { db } = await import("../.test-build/db.js");

const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03"];
const DAY = DAYS[0];
const ICS_KEY = "life:gym-1";

beforeEach(() => {
  const conn = db();
  for (const t of [
    "item_notes", "tasks", "board_order", "ics_events", "calendars",
    "local_events", "hidden_occurrences", "completions",
  ]) {
    conn.prepare(`DELETE FROM ${t}`).run();
  }
  conn
    .prepare(
      `INSERT INTO calendars (id, name, color, kind, url, enabled, position)
       VALUES ('life', 'Life', '#fff', 'ics', 'http://x', 1, 0)`,
    )
    .run();
  conn
    .prepare(
      `INSERT INTO ics_events
         (key, calendar_id, uid, recurrence_id, title, ymd, start_min, end_ymd, end_min, all_day, notes)
       VALUES (?, 'life', 'gym-1', NULL, 'Gym', ?, 420, ?, 480, 0, NULL)`,
    )
    .run(ICS_KEY, DAY, DAY);
});

const rowCount = () =>
  db().prepare("SELECT COUNT(*) AS n FROM item_notes").get().n;

const board = () =>
  buildBoardItems(DAYS, store.getOccurrences(DAYS[0], DAYS.at(-1)), store.listTasks(DAYS[0], DAYS.at(-1)));

test("a note round-trips", () => {
  notes.setNote("task:abc", "Ring the clinic\n- [x] find referral");
  assert.equal(notes.getNote("task:abc"), "Ring the clinic\n- [x] find referral");
  assert.equal(notes.getNote("task:nothing-here"), "", "no note reads as empty, not null");
});

test("emptying a note removes the row rather than storing blank", () => {
  notes.setNote("task:abc", "something");
  assert.equal(rowCount(), 1);
  notes.setNote("task:abc", "");
  assert.equal(rowCount(), 0);
});

test("a note whittled down to empty tick-boxes counts as empty", () => {
  // Otherwise the board keeps a marker pointing at a blank panel.
  notes.setNote("task:abc", "- [ ] \n- [x] \n   ");
  assert.equal(rowCount(), 0);
});

test("the board reports which rows have notes, and their tick progress", () => {
  const t = store.createTask({ ymd: DAY, title: "Admin" });
  notes.setNote(taskKey(t.id), "- [x] one\n- [ ] two\n- [ ] three");
  notes.setNote(ICS_KEY, "just words, no boxes");

  const items = board()[DAY];
  const todo = items.find((i) => i.key === taskKey(t.id));
  const event = items.find((i) => i.key === ICS_KEY);

  assert.equal(todo.hasNote, true);
  assert.deepEqual(todo.checks, { done: 1, total: 3 });
  assert.equal(event.hasNote, true);
  assert.equal(event.checks, null, "no boxes, so no progress to show");
});

test("an item with no note says so", () => {
  store.createTask({ ymd: DAY, title: "Admin" });
  const item = board()[DAY].find((i) => i.kind === "task");
  assert.equal(item.hasNote, false);
  assert.equal(item.checks, null);
});

test("deleting a to-do takes its note with it", () => {
  const t = store.createTask({ ymd: DAY, title: "Admin" });
  notes.setNote(taskKey(t.id), "context");
  assert.equal(rowCount(), 1);

  store.deleteTask(t.id);
  assert.equal(rowCount(), 0);
});

test("writing a note on an iCloud event does not detach a local copy", () => {
  notes.setNote(ICS_KEY, "bring the shoes");

  assert.equal(
    db().prepare("SELECT COUNT(*) AS n FROM local_events").get().n,
    0,
    "the event still mirrors iCloud",
  );
  assert.equal(
    db().prepare("SELECT COUNT(*) AS n FROM hidden_occurrences").get().n,
    0,
  );
  assert.equal(board()[DAY].find((i) => i.key === ICS_KEY).hasNote, true);
});

test("a note follows an iCloud event when a move does detach it", () => {
  notes.setNote(ICS_KEY, "bring the shoes");
  const moved = moveBoardItem(ICS_KEY, DAY, DAYS[1], { beforeKey: null, afterKey: null }, DAYS);

  assert.notEqual(moved.key, ICS_KEY, "moving days detaches a local copy");
  assert.equal(notes.getNote(moved.key), "bring the shoes");
  assert.equal(notes.getNote(ICS_KEY), "", "and is not left on the dead key");
  assert.equal(rowCount(), 1);
});

test("a note follows a retimed iCloud event too", () => {
  notes.setNote(ICS_KEY, "bring the shoes");
  const moved = setItemTime(ICS_KEY, DAY, 600);

  assert.notEqual(moved.key, ICS_KEY);
  assert.equal(notes.getNote(moved.key), "bring the shoes");
  assert.equal(rowCount(), 1);
});

test("a note survives a calendar-page drag, which detaches through moveOccurrence", () => {
  // The calendar grid PATCHes /api/events, which never knew about notes.
  notes.setNote(ICS_KEY, "bring the shoes");
  const moved = store.moveOccurrence(ICS_KEY, DAYS[1]);

  assert.notEqual(moved.key, ICS_KEY);
  assert.equal(notes.getNote(moved.key), "bring the shoes");
  assert.equal(rowCount(), 1);
});

test("deleting a detached local event takes its note with it", () => {
  notes.setNote(ICS_KEY, "bring the shoes");
  const moved = store.moveOccurrence(ICS_KEY, DAYS[1]);
  assert.equal(rowCount(), 1);

  store.deleteLocalEvent(moved.key.slice("local:".length));
  assert.equal(rowCount(), 0, "no orphan left behind");
});

test("relinking onto a key that already has a note keeps one row", () => {
  notes.setNote("local:a", "old");
  notes.setNote(ICS_KEY, "new");
  notes.relinkNote(ICS_KEY, "local:a");

  assert.equal(rowCount(), 1);
  assert.equal(notes.getNote("local:a"), "new", "the arriving note wins");
});
