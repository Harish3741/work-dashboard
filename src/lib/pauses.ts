import { db, newId, nowIso } from "./db.js";
import { getJson, setJson } from "./meta.js";
import type { PauseRecord } from "./away.js";

export { pausedDaysInWeek, isPaused, currentOrNextPause, type PauseRecord } from "./away.js";

/**
 * Time away. A pause is a closed range of days on which habits are neither
 * required nor broken — the week's target shrinks to the days at home, and a
 * week spent entirely away is skipped by streaks rather than ending them.
 *
 * Two ways in: typing "travel …" on the board (the composer asks for the
 * return date), and a flight or booking the message inbox spotted, which
 * arrives as a *pending* pause and only counts once approved. Nothing else
 * in the app knows or cares where a pause came from.
 */

type Row = {
  id: string;
  from_ymd: string;
  to_ymd: string;
  label: string;
  source: string;
  pending: number;
  created_at: string;
  origin_key: string | null;
};

const COLUMNS = "id, from_ymd, to_ymd, label, source, pending, created_at, origin_key";

function toRecord(row: Row): PauseRecord {
  return {
    id: row.id,
    fromYmd: row.from_ymd,
    toYmd: row.to_ymd,
    label: row.label,
    source: row.source === "inbox" ? "inbox" : row.source === "calendar" ? "calendar" : "board",
    pending: row.pending === 1,
    createdAt: row.created_at,
    originKey: row.origin_key ?? null,
  };
}

/** Every pause, newest first. Pass `activeOnly` to skip pending proposals. */
export function listPauses(activeOnly = false): PauseRecord[] {
  const rows = db()
    .prepare(
      `SELECT ${COLUMNS} FROM pauses
        ${activeOnly ? "WHERE pending = 0" : ""} ORDER BY from_ymd DESC, created_at DESC`,
    )
    .all() as Row[];
  return rows.map(toRecord);
}

export function getPause(id: string): PauseRecord | null {
  const row = db()
    .prepare(`SELECT ${COLUMNS} FROM pauses WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? toRecord(row) : null;
}

export function createPause(input: {
  fromYmd: string;
  toYmd: string;
  label?: string;
  source?: PauseRecord["source"];
  pending?: boolean;
  originKey?: string | null;
  /** The phone mints the id of a pause it creates; a replay finds it and changes nothing. */
  id?: string;
}): PauseRecord {
  const existing = input.id ? getPause(input.id) : null;
  if (existing) return existing;
  // A range typed backwards is still a range.
  const [fromYmd, toYmd] =
    input.fromYmd <= input.toYmd ? [input.fromYmd, input.toYmd] : [input.toYmd, input.fromYmd];
  const record: PauseRecord = {
    id: input.id ?? newId(),
    fromYmd,
    toYmd,
    label: (input.label ?? "").trim(),
    source: input.source ?? "board",
    pending: input.pending ?? false,
    createdAt: nowIso(),
    originKey: input.originKey ?? null,
  };
  db()
    .prepare(
      `INSERT INTO pauses (id, from_ymd, to_ymd, label, source, pending, created_at, origin_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.fromYmd,
      record.toYmd,
      record.label,
      record.source,
      record.pending ? 1 : 0,
      record.createdAt,
      record.originKey,
    );
  return record;
}

/** Move a pause's dates (a rescheduled flight); the label follows too. */
export function updatePause(id: string, patch: { fromYmd: string; toYmd: string; label?: string }): void {
  const [fromYmd, toYmd] =
    patch.fromYmd <= patch.toYmd ? [patch.fromYmd, patch.toYmd] : [patch.toYmd, patch.fromYmd];
  if (patch.label === undefined) {
    db().prepare("UPDATE pauses SET from_ymd = ?, to_ymd = ? WHERE id = ?").run(fromYmd, toYmd, id);
  } else {
    db()
      .prepare("UPDATE pauses SET from_ymd = ?, to_ymd = ?, label = ? WHERE id = ?")
      .run(fromYmd, toYmd, patch.label.trim(), id);
  }
}

/** A pending proposal the user approved: it counts from now on. */
export function activatePause(id: string): void {
  db().prepare("UPDATE pauses SET pending = 0 WHERE id = ?").run(id);
}

/**
 * Remove a pause. One derived from the calendar is also remembered as
 * dismissed, so the next sync does not quietly put it back.
 */
export function deletePause(id: string): void {
  const existing = getPause(id);
  if (existing?.source === "calendar" && existing.originKey) dismissOrigin(existing.originKey);
  db().prepare("DELETE FROM pauses WHERE id = ?").run(id);
}

/**
 * The to-do that started a pause ("travel to tokyo" → back on?) owns it:
 * delete the to-do and the pause goes too. Called from the task store.
 */
export function deletePausesFor(originKey: string): number {
  return db().prepare("DELETE FROM pauses WHERE origin_key = ? AND source = 'board'").run(originKey).changes;
}

const DISMISSED_KEY = "pauses.dismissed";

export function dismissedOrigins(): Set<string> {
  return new Set(getJson<string[]>(DISMISSED_KEY, []));
}

function dismissOrigin(originKey: string): void {
  const set = dismissedOrigins();
  set.add(originKey);
  setJson(DISMISSED_KEY, [...set].slice(-200));
}
