import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { noteChange } from "./changes.js";

/**
 * SQLite lives on disk next to the app. It holds three kinds of thing:
 *   - a cache of calendar-feed events (disposable; rebuilt on every sync)
 *   - local events, habits, to-dos, notes and contacts (the actual user data)
 *   - per-calendar sync bookkeeping
 *
 * Nothing here is ever pushed back to a calendar.
 */

const DATA_DIR = process.env.HABIT_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "habits.db");

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  migrate(conn);
  addHabitMetric(conn);
  relaxCompletionHabit(conn);
  addTaskStartMin(conn);
  addHabitCreatedAt(conn);
  addPauseOrigin(conn);
  addIcsCallDetails(conn);
  // Last: its triggers name tasks.start_min, which addTaskStartMin adds, and
  // relaxCompletionHabit rebuilds completions (dropping any trigger on it).
  addItemChanges(conn);
  installChangeHooks(conn);
  seedCalendarsFromEnv(conn);
  instance = conn;
  return conn;
}

function migrate(conn: Database.Database) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS calendars (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      color     TEXT NOT NULL DEFAULT '#8b8b8b',
      kind      TEXT NOT NULL DEFAULT 'ics',
      url       TEXT NOT NULL,
      enabled   INTEGER NOT NULL DEFAULT 1,
      position  INTEGER NOT NULL DEFAULT 0
    );

    -- Cache of expanded feed occurrences. Wiped and rewritten per calendar
    -- on each sync, so it must never hold user-authored data.
    CREATE TABLE IF NOT EXISTS ics_events (
      key           TEXT PRIMARY KEY,
      calendar_id   TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      uid           TEXT NOT NULL,
      recurrence_id TEXT,
      title         TEXT NOT NULL,
      ymd           TEXT NOT NULL,
      start_min     INTEGER,
      end_ymd       TEXT NOT NULL,
      end_min       INTEGER,
      all_day       INTEGER NOT NULL DEFAULT 0,
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS ics_events_ymd ON ics_events(ymd);
    CREATE INDEX IF NOT EXISTS ics_events_cal ON ics_events(calendar_id);

    CREATE TABLE IF NOT EXISTS local_events (
      id                TEXT PRIMARY KEY,
      calendar_id       TEXT REFERENCES calendars(id) ON DELETE SET NULL,
      title             TEXT NOT NULL,
      ymd               TEXT NOT NULL,
      start_min         INTEGER,
      end_ymd           TEXT NOT NULL,
      end_min           INTEGER,
      all_day           INTEGER NOT NULL DEFAULT 0,
      notes             TEXT,
      detached_from_key TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS local_events_ymd ON local_events(ymd);
    -- Looked up before detaching, so a replayed drag moves the copy that
    -- already exists instead of making a second one. Not unique: databases
    -- from before that check may already hold a duplicate pair, and this DDL
    -- runs at startup.
    CREATE INDEX IF NOT EXISTS local_events_detached
      ON local_events(detached_from_key);

    -- feed occurrences hidden because they were dragged into a local copy.
    CREATE TABLE IF NOT EXISTS hidden_occurrences (
      key        TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS habits (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      match_title  TEXT NOT NULL,
      match_mode   TEXT NOT NULL DEFAULT 'exact',
      calendar_id  TEXT REFERENCES calendars(id) ON DELETE SET NULL,
      target_type  TEXT NOT NULL DEFAULT 'times_per_week',
      target_count INTEGER NOT NULL DEFAULT 1,
      color        TEXT NOT NULL DEFAULT '#e8734a',
      archived     INTEGER NOT NULL DEFAULT 0,
      position     INTEGER NOT NULL DEFAULT 0,
      -- The week this falls in is the first one that may require the habit.
      -- Weeks before it are scored as though the habit did not exist, which
      -- is what stops a new habit retroactively spoiling a year of results.
      created_at   TEXT
    );

    -- One row per ticked event. Ticking an event is the only way a habit gets
    -- credited, so this is keyed by occurrence, not by habit+day. habit_id is
    -- null for ticked events that match no habit — those are just to-dos.
    CREATE TABLE IF NOT EXISTS completions (
      occurrence_key TEXT PRIMARY KEY,
      habit_id       TEXT REFERENCES habits(id) ON DELETE CASCADE,
      ymd            TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS completions_habit_ymd ON completions(habit_id, ymd);

    -- Free-text to-dos on the board. Purely local: they are never events,
    -- never reach a calendar, and never appear on the calendar grid.
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      ymd        TEXT NOT NULL,
      title      TEXT NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_ymd ON tasks(ymd);
    CREATE INDEX IF NOT EXISTS tasks_open ON tasks(done, ymd);

    -- Daily numeric readings imported from outside the app (currently step
    -- counts pushed from Health via a Shortcut). One row per day per kind.
    CREATE TABLE IF NOT EXISTS metrics (
      ymd        TEXT NOT NULL,
      kind       TEXT NOT NULL,
      value      REAL NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (ymd, kind)
    );

    -- Days the user is away. Habits are neither required nor broken on these
    -- days: weekly targets shrink to the days at home, and a week entirely
    -- inside a pause is skipped by streaks. pending = 1 rows are proposals from
    -- the message inbox awaiting approval and do not count.
    CREATE TABLE IF NOT EXISTS pauses (
      id         TEXT PRIMARY KEY,
      from_ymd   TEXT NOT NULL,
      to_ymd     TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'board',
      pending    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      -- source = 'calendar': the flight event this was derived from, so a
      -- re-sync updates it in place and a dismissed one is not re-created.
      origin_key TEXT
    );
    CREATE INDEX IF NOT EXISTS pauses_range ON pauses(from_ymd, to_ymd);

    -- Small key/value scratchpad for app bookkeeping.
    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- "Need to action": an undated backlog list in the sidebar. Deliberately
    -- not a task — it has no day, so it never reaches the board or a calendar.
    CREATE TABLE IF NOT EXISTS action_items (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Manual board ordering. A row exists only for an item the user has
    -- actually dragged; everything else falls back to its time. Positions live
    -- in the same "minutes past midnight" space as start_min (see lib/board),
    -- so a dragged item and a freshly synced 10am event still sort sensibly
    -- against each other. item_key is an occurrence key or "task:<id>".
    CREATE TABLE IF NOT EXISTS board_order (
      ymd      TEXT NOT NULL,
      item_key TEXT NOT NULL,
      position REAL NOT NULL,
      PRIMARY KEY (ymd, item_key)
    );

    -- Free-text notes on a board item, with "- [ ] " lines rendered as
    -- tick-boxes (see lib/checklist). Keyed by board item key, so a to-do, a
    -- local event and a feed occurrence all store notes the same way — and
    -- adding a note to a feed event does NOT detach a local copy of it, the
    -- way editing its title or time would. Nothing here is sent to iCloud or
    -- to Reminders.
    CREATE TABLE IF NOT EXISTS item_notes (
      item_key   TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      calendar_id  TEXT PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE,
      last_sync_at TEXT,
      last_status  TEXT NOT NULL DEFAULT 'never',
      last_error   TEXT
    );

    -- The Dashboard's contacts. A flat list with an event column rather than
    -- a group per event, so someone at two of them is one row, not two.
    CREATE TABLE IF NOT EXISTS contacts (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT,
      org        TEXT,
      email      TEXT,
      phone      TEXT,
      event      TEXT,
      category   TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contacts_event ON contacts(event);
  `);
}

/**
 * A habit can be driven by a daily metric instead of by ticking events: it
 * counts as done on any day whose reading reaches the threshold. Null metric
 * kind means the habit works the original way, off matched event titles.
 */
function addHabitMetric(conn: Database.Database) {
  const columns = conn.prepare("PRAGMA table_info(habits)").all() as { name: string }[];
  if (columns.some((c) => c.name === "metric_kind")) return;
  conn.exec("ALTER TABLE habits ADD COLUMN metric_kind TEXT");
  conn.exec("ALTER TABLE habits ADD COLUMN metric_threshold REAL");
}

/** SQLite's own clock, in exactly the shape `new Date().toISOString()` produces. */
const STAMP = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Record a change to an item. `deleted` says whether the item still exists. */
function touch(keyExpr: string, deleted: 0 | 1): string {
  return `INSERT INTO item_changes (item_key, changed_at, deleted)
            VALUES (${keyExpr}, ${STAMP}, ${deleted})
            ON CONFLICT(item_key) DO UPDATE
              SET changed_at = excluded.changed_at, deleted = excluded.deleted;`;
}

/** Record a tick or untick: a change, but never a statement about existence. */
function touchDone(keyExpr: string): string {
  return `INSERT INTO item_changes (item_key, changed_at, deleted)
            VALUES (${keyExpr}, ${STAMP}, 0)
            ON CONFLICT(item_key) DO UPDATE SET changed_at = excluded.changed_at;`;
}

/**
 * When each item last changed in the app, keyed "task:<id>", "action:<id>",
 * "local:<id>" or a feed occurrence key. tasks and action_items carry no
 * updated_at of their own, and a delete leaves nothing behind to date at all —
 * hence a separate table. Handy for wiring up your own two-way sync later.
 *
 * Fed by triggers rather than by store.ts, so every writer is covered whether
 * or not it goes through the store. They are plain SQL on purpose
 * — no application-defined function — so any other connection to this file
 * (the sqlite3 CLI, a second process) can still write to these
 * tables. A trigger that called a JS function would fail on every connection
 * that had not registered it.
 *
 * Only a real change counts: an UPDATE that rewrites a column with its own
 * value is not an edit. ics_events is deliberately not watched — the calendar
 * sync rewrites it wholesale every hour, and a feed occurrence's title is
 * not the user's to change here anyway; its ticks (completions) and hides are.
 */
function addItemChanges(conn: Database.Database) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS item_changes (
      item_key   TEXT PRIMARY KEY,
      changed_at TEXT NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TRIGGER IF NOT EXISTS item_changes_task_insert AFTER INSERT ON tasks
    BEGIN ${touch("'task:' || NEW.id", 0)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_task_update
      AFTER UPDATE OF title, done, ymd, start_min ON tasks
      WHEN OLD.title IS NOT NEW.title OR OLD.done IS NOT NEW.done
        OR OLD.ymd IS NOT NEW.ymd OR OLD.start_min IS NOT NEW.start_min
    BEGIN ${touch("'task:' || NEW.id", 0)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_task_delete AFTER DELETE ON tasks
    BEGIN ${touch("'task:' || OLD.id", 1)} END;

    CREATE TRIGGER IF NOT EXISTS item_changes_action_insert AFTER INSERT ON action_items
    BEGIN ${touch("'action:' || NEW.id", 0)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_action_update
      AFTER UPDATE OF title, done ON action_items
      WHEN OLD.title IS NOT NEW.title OR OLD.done IS NOT NEW.done
    BEGIN ${touch("'action:' || NEW.id", 0)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_action_delete AFTER DELETE ON action_items
    BEGIN ${touch("'action:' || OLD.id", 1)} END;

    CREATE TRIGGER IF NOT EXISTS item_changes_local_insert AFTER INSERT ON local_events
    BEGIN ${touch("'local:' || NEW.id", 0)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_local_update
      AFTER UPDATE OF title, ymd, start_min, all_day ON local_events
      WHEN OLD.title IS NOT NEW.title OR OLD.ymd IS NOT NEW.ymd
        OR OLD.start_min IS NOT NEW.start_min OR OLD.all_day IS NOT NEW.all_day
    BEGIN ${touch("'local:' || NEW.id", 0)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_local_delete AFTER DELETE ON local_events
    BEGIN ${touch("'local:' || OLD.id", 1)} END;

    -- An event's tick lives here, and so does a to-do's habit credit (keyed
    -- "task:<id>", the same key as the to-do). Readings from Health are
    -- "metric:" rows and are nobody's item.
    CREATE TRIGGER IF NOT EXISTS item_changes_completion_insert AFTER INSERT ON completions
      WHEN NEW.occurrence_key NOT LIKE 'metric:%'
    BEGIN ${touchDone("NEW.occurrence_key")} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_completion_delete AFTER DELETE ON completions
      WHEN OLD.occurrence_key NOT LIKE 'metric:%'
    BEGIN ${touchDone("OLD.occurrence_key")} END;

    -- Hiding a feed occurrence is how it is deleted here; un-hiding (when
    -- its detached copy is deleted) brings it back.
    CREATE TRIGGER IF NOT EXISTS item_changes_hidden_insert AFTER INSERT ON hidden_occurrences
    BEGIN ${touch("NEW.key", 1)} END;
    CREATE TRIGGER IF NOT EXISTS item_changes_hidden_delete AFTER DELETE ON hidden_occurrences
    BEGIN ${touch("OLD.key", 0)} END;
  `);
}

/**
 * Tell the change bus (lib/changes.ts) about every write, on THIS connection
 * only.
 *
 * TEMP triggers live in the connection that created them and nowhere else, so
 * the sqlite3 CLI or a second process never meet a trigger that calls a
 * function they have not registered — the persistent item_changes triggers
 * above stay plain SQL for exactly that reason. These ride on top of them:
 * item_changes already hears every edit, tick, delete and hide of an item, so
 * one pair of triggers there covers every writer. The board's hand order
 * (board_order) and the backlog's (action_items.position) are watched too. ics_events is not: the hourly calendar sync rewrites it
 * wholesale and says so once itself (`noteChange("calendar")`).
 */
function installChangeHooks(conn: Database.Database) {
  conn.function("habits_touch", { deterministic: false }, (key: unknown) => {
    noteChange(String(key));
    return null;
  });
  conn.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS changes_item_insert AFTER INSERT ON main.item_changes
    BEGIN SELECT habits_touch(NEW.item_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS changes_item_update AFTER UPDATE ON main.item_changes
    BEGIN SELECT habits_touch(NEW.item_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS changes_order_insert AFTER INSERT ON main.board_order
    BEGIN SELECT habits_touch(NEW.item_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS changes_order_update AFTER UPDATE ON main.board_order
    BEGIN SELECT habits_touch(NEW.item_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS changes_order_delete AFTER DELETE ON main.board_order
    BEGIN SELECT habits_touch(OLD.item_key); END;
    CREATE TEMP TRIGGER IF NOT EXISTS changes_action_order AFTER UPDATE OF position ON main.action_items
      WHEN OLD.position IS NOT NEW.position
    BEGIN SELECT habits_touch('action:' || NEW.id); END;
  `);
}

/**
 * Tasks gained an optional time so they can be scheduled alongside events on
 * the board. Null still means "no time" and sorts after everything timed.
 */
/** Pauses derived from calendar flights remember which flight, so they can follow it. */
function addPauseOrigin(conn: Database.Database) {
  const columns = conn.prepare("PRAGMA table_info(pauses)").all() as { name: string }[];
  if (columns.some((c) => c.name === "origin_key")) return;
  conn.exec("ALTER TABLE pauses ADD COLUMN origin_key TEXT");
}

function addTaskStartMin(conn: Database.Database) {
  const columns = conn.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (columns.some((c) => c.name === "start_min")) return;
  conn.exec("ALTER TABLE tasks ADD COLUMN start_min INTEGER");
}

/**
 * Habits gained a start date, so a habit added today cannot make every earlier
 * week in the year look like a failure.
 *
 * Existing habits are backfilled from their own first completion rather than
 * from "now" — they were plainly being tracked from then, and dating them today
 * would wrongly excuse every week they have already been scored on. A habit
 * with no completions at all falls back to today, which excuses nothing that
 * ever counted.
 */
function addHabitCreatedAt(conn: Database.Database) {
  const columns = conn.prepare("PRAGMA table_info(habits)").all() as { name: string }[];
  if (columns.length === 0) return;
  if (!columns.some((c) => c.name === "created_at")) {
    conn.exec("ALTER TABLE habits ADD COLUMN created_at TEXT");
  }
  conn.exec(`
    UPDATE habits SET created_at = COALESCE(
      (SELECT MIN(ymd) FROM completions WHERE completions.habit_id = habits.id),
      date('now', 'localtime')
    )
    WHERE created_at IS NULL OR created_at = ''
  `);
}

/**
 * Each cached occurrence keeps its conference URL and attendees (JSON
 * `[{name, email}]`), for anything that wants to know which events are calls.
 * Cache columns like the rest of ics_events —
 * rewritten on every sync, so a database from before this fills in on the
 * next calendar pull.
 */
function addIcsCallDetails(conn: Database.Database) {
  const columns = conn.prepare("PRAGMA table_info(ics_events)").all() as { name: string }[];
  if (columns.length === 0) return;
  const has = new Set(columns.map((c) => c.name));
  if (!has.has("conference_url")) conn.exec("ALTER TABLE ics_events ADD COLUMN conference_url TEXT");
  if (!has.has("attendees")) conn.exec("ALTER TABLE ics_events ADD COLUMN attendees TEXT");
}


/**
 * Any event can be ticked now, not just habit-matching ones, so completions
 * carry a nullable habit_id. SQLite cannot drop a NOT NULL constraint in
 * place, so rebuild the table when an older database is opened.
 */
function relaxCompletionHabit(conn: Database.Database) {
  const columns = conn.prepare("PRAGMA table_info(completions)").all() as {
    name: string;
    notnull: number;
  }[];
  const habitId = columns.find((c) => c.name === "habit_id");
  if (!habitId || habitId.notnull === 0) return;

  conn.transaction(() => {
    conn.exec(`
      CREATE TABLE completions_new (
        occurrence_key TEXT PRIMARY KEY,
        habit_id       TEXT REFERENCES habits(id) ON DELETE CASCADE,
        ymd            TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      INSERT INTO completions_new SELECT occurrence_key, habit_id, ymd, created_at FROM completions;
      DROP TABLE completions;
      ALTER TABLE completions_new RENAME TO completions;
      CREATE INDEX IF NOT EXISTS completions_habit_ymd ON completions(habit_id, ymd);
    `);
  })();
}

const DEFAULT_COLORS: Record<string, string> = {
  work: "#5b8def",
  meetings: "#a970e0",
  projects: "#e0a33e",
  personal: "#4ec98a",
};

/**
 * First-run convenience: seed calendars from CALENDAR_<NAME>_URL env vars so a
 * fresh clone can be configured entirely from .env.local. Calendars are
 * editable in the UI afterwards, and existing rows are never overwritten.
 */
function seedCalendarsFromEnv(conn: Database.Database) {
  const existing = conn.prepare("SELECT COUNT(*) AS n FROM calendars").get() as { n: number };
  if (existing.n > 0) return;

  const insert = conn.prepare(
    `INSERT INTO calendars (id, name, color, kind, url, enabled, position)
     VALUES (@id, @name, @color, 'ics', @url, 1, @position)`,
  );

  let position = 0;
  for (const [envKey, url] of Object.entries(process.env)) {
    const match = envKey.match(/^CALENDAR_(.+)_URL$/);
    if (!match || !url) continue;
    const name = match[1]
      .toLowerCase()
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    insert.run({
      id: randomUUID(),
      name,
      color: DEFAULT_COLORS[name.toLowerCase()] ?? "#8b8b8b",
      url,
      position: position++,
    });
  }
}

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
