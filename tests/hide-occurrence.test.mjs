import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * × on an iCloud event takes it off the board without touching the feed:
 * the occurrence is hidden in this app, its tick and hand placement go with
 * it, and a later sync does not bring it back. Unknown keys are refused.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-hide-"));
process.env.HABIT_DATA_DIR = dataDir;

const store = await import("../.test-build/store.js");
const { db } = await import("../.test-build/db.js");

const KEY = "life:gym-1";

beforeEach(() => {
  const conn = db();
  for (const t of ["ics_events", "calendars", "hidden_occurrences", "completions", "board_order"]) {
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

const visible = () => store.getOccurrences("2026-08-20", "2026-08-20").map((o) => o.key);

test("hiding an iCloud occurrence removes it from the board and clears its tick", () => {
  const conn = db();
  conn
    .prepare("INSERT INTO completions (occurrence_key, ymd, created_at) VALUES (?, '2026-08-20', 'now')")
    .run(KEY);
  assert.deepEqual(visible(), [KEY]);

  assert.equal(store.hideOccurrence(KEY), true);
  assert.deepEqual(visible(), []);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM completions").get().n, 0);

  // A re-sync re-inserts the same key; it stays hidden.
  conn
    .prepare(
      `INSERT OR REPLACE INTO ics_events
         (key, calendar_id, uid, recurrence_id, title, ymd, start_min, end_ymd, end_min, all_day, notes)
       VALUES (?, 'life', 'gym-1', NULL, 'Gym', '2026-08-20', 420, '2026-08-20', 480, 0, NULL)`,
    )
    .run(KEY);
  assert.deepEqual(visible(), []);
});

test("unknown keys are refused and nothing is hidden", () => {
  assert.equal(store.hideOccurrence("life:nope"), false);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM hidden_occurrences").get().n, 0);
  assert.deepEqual(visible(), [KEY]);
});
