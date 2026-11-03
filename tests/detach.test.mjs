import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Moving an iCloud event to another day detaches a local copy, because the feed
 * is read-only. Doing it twice with the same key must not make two copies —
 * and it used to, because the original is hidden the moment it detaches, so the
 * duplicate was invisible on the board and only showed up as a second reminder
 * on the phone. A tab holding the pre-detach key is enough to trigger it: a
 * second drag before the refetch lands, or a drag replayed from the phone's
 * offline queue.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-detach-"));
process.env.HABIT_DATA_DIR = dataDir;

const store = await import("../.test-build/store.js");
const { db } = await import("../.test-build/db.js");

const KEY = "life:gym-1";

beforeEach(() => {
  const conn = db();
  for (const t of ["ics_events", "calendars", "hidden_occurrences", "completions", "local_events", "board_order"]) {
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
       VALUES (?, 'life', 'gym-1', NULL, 'Gym', '2026-08-20', 420, '2026-08-20', 480, 0, NULL)`,
    )
    .run(KEY);
});

const copies = () =>
  db().prepare("SELECT id, ymd, start_min AS startMin FROM local_events WHERE detached_from_key = ?").all(KEY);

test("dragging the same iCloud event twice moves one copy rather than making two", () => {
  const first = store.moveOccurrence(KEY, "2026-08-21");
  assert.equal(copies().length, 1);

  // The tab still holds the old key and drags again before refetching.
  const second = store.moveOccurrence(KEY, "2026-08-22");
  assert.equal(copies().length, 1, "still one copy");
  assert.equal(second.key, first.key, "and it is the same one");
  assert.equal(copies()[0].ymd, "2026-08-22", "moved to where it was dropped");
});

test("a replayed retime lands on the copy too", () => {
  const first = store.moveOccurrence(KEY, "2026-08-21", 600);
  const second = store.moveOccurrence(KEY, "2026-08-21", 660);

  assert.equal(copies().length, 1);
  assert.equal(second.key, first.key);
  assert.equal(copies()[0].startMin, 660);
});

test("the original stays hidden, and the tick follows the copy", () => {
  db()
    .prepare("INSERT INTO completions (occurrence_key, ymd, created_at) VALUES (?, '2026-08-20', 'now')")
    .run(KEY);

  const moved = store.moveOccurrence(KEY, "2026-08-21");
  store.moveOccurrence(KEY, "2026-08-22");

  const visible = store.getOccurrences("2026-08-20", "2026-08-22");
  assert.deepEqual(
    visible.map((o) => o.key),
    [moved.key],
    "one event on the calendar, not two",
  );
  assert.equal(visible[0].completed, true, "and it kept its tick");
});
