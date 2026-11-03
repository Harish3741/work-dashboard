import { db, nowIso } from "./db.js";
import { isEmpty, parseNotes } from "./checklist.js";

/**
 * Notes on a board item — a to-do or an event — stored against the item's key.
 *
 * One table for both kinds on purpose. A note is not part of an event, it is
 * something of the user's attached to one, so writing a note on an iCloud
 * occurrence must not detach a local copy the way retiming it does. Keying on
 * the item key rather than adding a column to `tasks` is what buys that.
 *
 * Nothing here leaves the app: notes are not mirrored to Reminders (the notes
 * field of a reminder carries the `habits:` identity marker and nothing else)
 * and there is no write path to the calendar.
 */

export function getNote(itemKey: string): string {
  const row = db()
    .prepare("SELECT body FROM item_notes WHERE item_key = ?")
    .get(itemKey) as { body: string } | undefined;
  return row?.body ?? "";
}

/**
 * Write a note, or drop the row when there is nothing left in it.
 *
 * "Nothing left" means no words — a note whittled down to empty tick-boxes is
 * still empty, and leaving it stored would keep a marker on the board row
 * pointing at a blank panel.
 */
export function setNote(itemKey: string, body: string): void {
  if (isEmpty(parseNotes(body))) {
    deleteNote(itemKey);
    return;
  }
  db()
    .prepare(
      `INSERT INTO item_notes (item_key, body, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    )
    .run(itemKey, body, nowIso());
}

export function deleteNote(itemKey: string): void {
  db().prepare("DELETE FROM item_notes WHERE item_key = ?").run(itemKey);
}

/**
 * Carry a note across a key change.
 *
 * Moving or retiming a feed event detaches a local copy under a new key;
 * without this the note would be stranded on a key nothing renders any more.
 */
export function relinkNote(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  db()
    .prepare("UPDATE OR REPLACE item_notes SET item_key = ? WHERE item_key = ?")
    .run(toKey, fromKey);
}

/**
 * Every note in a date range's worth of items, for the board's row markers.
 *
 * Read in one go rather than per row: the board renders three weeks at a time,
 * and a query per item would be a few hundred of them on every refetch.
 */
export function allNotes(): Map<string, string> {
  const rows = db()
    .prepare("SELECT item_key AS itemKey, body FROM item_notes")
    .all() as { itemKey: string; body: string }[];
  return new Map(rows.map((r) => [r.itemKey, r.body]));
}
