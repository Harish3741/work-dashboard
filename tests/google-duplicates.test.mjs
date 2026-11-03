import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A Google invite the user also keeps in iCloud by hand shows once: the timed
 * Google copy in the same slot (day + start minute) gives way to the user's own
 * event. Nothing else about the Google feed is filtered here.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-gdup-"));
process.env.HABIT_DATA_DIR = dataDir;

const store = await import("../.test-build/store.js");
const { db } = await import("../.test-build/db.js");

const event = (calendar, uid, title, startMin, allDay = 0) =>
  db()
    .prepare(
      `INSERT INTO ics_events
         (key, calendar_id, uid, recurrence_id, title, ymd, start_min, end_ymd, end_min, all_day, notes)
       VALUES (?, ?, ?, NULL, ?, '2026-10-08', ?, '2026-10-08', ?, ?, NULL)`,
    )
    .run(`${calendar}:${uid}`, calendar, uid, title, startMin, startMin == null ? null : startMin + 35, allDay);

beforeEach(() => {
  const conn = db();
  for (const t of ["ics_events", "calendars", "local_events", "hidden_occurrences"]) {
    conn.prepare(`DELETE FROM ${t}`).run();
  }
  const cal = conn.prepare(
    `INSERT INTO calendars (id, name, color, kind, url, enabled, position) VALUES (?, ?, '#fff', 'ics', ?, 1, 0)`,
  );
  cal.run("life", "Life", "https://p103-caldav.icloud.com/published/2/abc");
  cal.run("google", "Google", "https://calendar.google.com/calendar/ical/me%40gmail.com/private-x/basic.ics");
});

const titles = () => store.getOccurrences("2026-10-08", "2026-10-08").map((o) => o.title).sort();

test("the Google copy of an event already in iCloud at the same minute is left out", () => {
  event("life", "le", "Client call", 630);
  event("google", "le-g", "Client call - Project kickoff (invite)", 630);
  assert.deepEqual(titles(), ["Client call"]);
});

test("a local event in the slot wins too", () => {
  store.createLocalEvent({ title: "Coffee", ymd: "2026-10-08", startMin: 600, endMin: 660 });
  event("google", "c", "Coffee with Sam", 600);
  assert.deepEqual(titles(), ["Coffee"]);
});

test("Google events at other times, and all-day ones, stay", () => {
  event("life", "le", "Client call", 630);
  event("life", "bday-i", "Mum's birthday", null, 1);
  event("google", "meet", "Team Sync", 1020);
  event("google", "bday-g", "Alex Birthday", null, 1);
  assert.deepEqual(titles(), ["Alex Birthday", "Client call", "Mum's birthday", "Team Sync"]);
});

test("two iCloud events in one slot are both kept — only Google copies give way", () => {
  event("life", "a", "Gym", 420);
  event("life", "b", "Call", 420);
  assert.deepEqual(titles(), ["Call", "Gym"]);
});
