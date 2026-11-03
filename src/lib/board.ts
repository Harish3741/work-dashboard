import { db } from "./db.js";
import { getMeta, setMeta } from "./meta.js";
import {
  createAction,
  createTask,
  deleteAction,
  deleteTask,
  getOccurrences,
  getTask,
  listTasks,
  moveAction,
  moveOccurrence,
  updateLocalEvent,
  updateTask,
  type ActionMoveTarget,
  type TaskRecord,
} from "./store.js";
import { allNotes, relinkNote } from "./notes.js";
import { checkCount, parseNotes } from "./checklist.js";
import { indexForNeighbours } from "./order.js";
import type { Occurrence } from "./types.js";

/**
 * The board shows events and to-dos as one list per day, and that list is
 * hand-orderable regardless of what time anything is at.
 *
 * To make "sorted by time" and "dragged into place" coexist, every item gets a
 * single numeric sort key in the same units as start_min — minutes past
 * midnight, so 9am is 540. An item's default key is its time; dragging one
 * writes an explicit key to board_order, taken as the midpoint between its new
 * neighbours. A freshly synced 10am event therefore still lands between a 9am
 * and a 12pm item, while anything the user has positioned by hand stays put.
 *
 * The drop is resolved here, from the database, rather than from numbers the
 * browser sends: the client says which items the dragged one landed *between*,
 * and this file works out what key that implies. A tab that has not refetched
 * since the last drag holds stale keys, so letting it do the arithmetic put
 * items in places nobody had dropped them.
 */

/** All-day things sort above the timed day. */
export const ALL_DAY_ORDER = -60;
/** To-dos with no time sort after the timed day, but before nothing else. */
export const UNTIMED_ORDER = 24 * 60 + 60;

/**
 * Two keys closer than this are the same position as far as the board is
 * concerned: there is no room to drop anything between them, and repeated
 * midpoints would grind the gap down to nothing. Well below a minute, so it
 * never rejects a gap a person could have meant.
 */
const MIN_GAP = 1e-3;
/** Room left either side when a drop lands at the top or bottom of a day. */
const EDGE_GAP = 60;

export type BoardItem = {
  /** Occurrence key for events, `task:<id>` for to-dos. */
  key: string;
  order: number;
  /** True when the position came from a drag rather than from the clock. */
  pinned: boolean;
  /** The item carries notes — the row marks it, double-click opens them. */
  hasNote: boolean;
  /** Tick-box progress within those notes, or null when the note has none. */
  checks: { done: number; total: number } | null;
} & ({ kind: "event"; occurrence: Occurrence } | { kind: "task"; task: TaskRecord });

export function taskKey(id: string): string {
  return `task:${id}`;
}

function isTaskKey(key: string): boolean {
  return key.startsWith("task:");
}

function defaultOrder(item: { kind: "event"; occurrence: Occurrence } | { kind: "task"; task: TaskRecord }): number {
  if (item.kind === "event") {
    if (item.occurrence.allDay) return ALL_DAY_ORDER;
    return item.occurrence.startMin ?? ALL_DAY_ORDER;
  }
  return item.task.startMin ?? UNTIMED_ORDER;
}

function readOrder(fromYmd: string, toYmd: string): Map<string, number> {
  const rows = db()
    .prepare(
      "SELECT ymd, item_key AS itemKey, position FROM board_order WHERE ymd BETWEEN ? AND ?",
    )
    .all(fromYmd, toYmd) as { ymd: string; itemKey: string; position: number }[];
  return new Map(rows.map((r) => [`${r.ymd} ${r.itemKey}`, r.position]));
}

/**
 * Build the ordered per-day lists the board renders.
 *
 * `days` is the display window. Unfinished to-dos dated before it are shown in
 * the first column, so an item's display column is not always its own ymd — but
 * its hand-set position is always stored against its own ymd, or it would be
 * lost the next morning when the window rolls forward a day.
 */
export function buildBoardItems(
  days: string[],
  occurrences: Occurrence[],
  tasks: TaskRecord[],
): Record<string, BoardItem[]> {
  if (days.length === 0) return {};
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  // Carried-over to-dos are dated before the window but shown inside it, so the
  // override read has to reach back far enough to find their positions.
  const earliest = tasks.reduce((min, t) => (t.ymd < min ? t.ymd : min), firstDay);
  const overrides = readOrder(earliest, lastDay);
  const inWindow = new Set(days);

  const byDay: Record<string, BoardItem[]> = {};
  for (const ymd of days) byDay[ymd] = [];

  const notes = allNotes();

  const push = (
    column: string,
    orderYmd: string,
    key: string,
    base: { kind: "event"; occurrence: Occurrence } | { kind: "task"; task: TaskRecord },
  ) => {
    if (!inWindow.has(column)) return;
    const override = overrides.get(`${orderYmd} ${key}`);
    const body = notes.get(key);
    const counts = body === undefined ? null : checkCount(parseNotes(body));
    byDay[column].push({
      ...base,
      key,
      order: override ?? defaultOrder(base),
      pinned: override !== undefined,
      hasNote: body !== undefined,
      checks: counts && counts.total > 0 ? counts : null,
    });
  };

  for (const occurrence of occurrences) {
    push(occurrence.ymd, occurrence.ymd, occurrence.key, { kind: "event", occurrence });
  }
  for (const task of tasks) {
    push(task.ymd < firstDay ? firstDay : task.ymd, task.ymd, taskKey(task.id), {
      kind: "task",
      task,
    });
  }

  for (const ymd of days) {
    byDay[ymd].sort((a, b) => (a.order === b.order ? a.key.localeCompare(b.key) : a.order - b.order));
  }
  return byDay;
}

function setPosition(ymd: string, itemKey: string, position: number): void {
  db()
    .prepare(
      `INSERT INTO board_order (ymd, item_key, position) VALUES (?, ?, ?)
         ON CONFLICT(ymd, item_key) DO UPDATE SET position = excluded.position`,
    )
    .run(ymd, itemKey, position);
}

function clearPosition(ymd: string, itemKey: string): void {
  db().prepare("DELETE FROM board_order WHERE ymd = ? AND item_key = ?").run(ymd, itemKey);
}

/**
 * A to-do has exactly one position, so a stale row under another date can only
 * be an orphan from before its date changed. Events are left alone: a multi-day
 * occurrence legitimately holds a row per day it appears on.
 */
function clearOtherPositions(ymd: string, itemKey: string): void {
  db()
    .prepare("DELETE FROM board_order WHERE item_key = ? AND ymd <> ?")
    .run(itemKey, ymd);
}

/* ------------------------------------------------------------------ placing */

/** One item's day-list neighbours, as the browser rendered them. */
export type Sibling = { key: string; order: number };
export type Placement = { key: string; position: number };

/**
 * The board_order rows that put `itemKey` at `index` among `siblings`.
 *
 * Usually one row: the midpoint of the two it landed between, so nothing else
 * has to be rewritten. The exception is a tie — and ties are the common case,
 * not an edge case, because every untimed to-do defaults to the same key
 * (UNTIMED_ORDER), as does every all-day event (ALL_DAY_ORDER) and every pair
 * of events at the same clock time. There is no number strictly between a value
 * and itself, so a midpoint there wrote the neighbours' own key back and the
 * day re-sorted on the key tie-break, snapping the item to where it started.
 * That run of tied items is respaced instead, which is the smallest rewrite
 * that can express the order the user just dragged.
 *
 * Null means "no explicit position": an empty day has nothing to sort against,
 * and pinning the item at 0 would park it at midnight, above every event synced
 * into that day afterwards.
 */
export function placeForDrop(
  siblings: Sibling[],
  index: number,
  itemKey: string,
): Placement[] | null {
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? siblings[at - 1].order : undefined;
  const after = at < siblings.length ? siblings[at].order : undefined;

  if (before === undefined && after === undefined) return null;
  if (before === undefined) return [{ key: itemKey, position: after! - EDGE_GAP }];
  if (after === undefined) return [{ key: itemKey, position: before + EDGE_GAP }];
  // Room for a midpoint that is clear of both sides: the common path, and the
  // one that leaves every other item's key untouched.
  if (after - before > 2 * MIN_GAP) {
    return [{ key: itemKey, position: (before + after) / 2 }];
  }

  // Tied. Widen to the whole indistinguishable run, then share out the space
  // between the first item strictly below it and the first strictly above.
  let lo = at - 1;
  while (lo > 0 && Math.abs(siblings[lo - 1].order - before) <= MIN_GAP) lo--;
  let hi = at + 1;
  while (hi < siblings.length && Math.abs(siblings[hi].order - before) <= MIN_GAP) hi++;

  // Stay near the key they were tied at, even when the nearest distinct
  // neighbour is hours away: untimed to-dos all sit at UNTIMED_ORDER above a
  // day of events, and spreading them down into the morning would put them
  // above every timed event synced in afterwards.
  const outerLow = Math.max(lo > 0 ? siblings[lo - 1].order : -Infinity, before - EDGE_GAP);
  const outerHigh = Math.min(
    hi < siblings.length ? siblings[hi].order : Infinity,
    before + EDGE_GAP,
  );
  const members = [
    ...siblings.slice(lo, at).map((s) => s.key),
    itemKey,
    ...siblings.slice(at, hi).map((s) => s.key),
  ];
  const step = (outerHigh - outerLow) / (members.length + 1);
  if (step > MIN_GAP) {
    return members.map((key, i) => ({ key, position: outerLow + step * (i + 1) }));
  }

  // A day compressed so hard that even its tied run has nowhere to go. Spread
  // the whole thing back out over the day rather than fail the drop.
  const all = [...siblings.map((s) => s.key)];
  all.splice(at, 0, itemKey);
  return all.map((key, i) => ({ key, position: ALL_DAY_ORDER + i * EDGE_GAP }));
}

/* -------------------------------------------------------------------- moving */

export type MoveResult = { key: string; detached: boolean };

/**
 * Where a drop landed. Neighbour keys are what the web client sends; the bare
 * index is the phone's offline queue, which was written before neighbours
 * existed and is replayed against whatever the board looks like on reconnect.
 */
export type MoveTarget =
  | { beforeKey: string | null; afterKey: string | null }
  | { index: number };

/**
 * Drop an item at a slot, moving it between days if `toYmd` differs from where
 * it is now.
 *
 * Reordering inside a day only writes board_order, so a feed event keeps
 * mirroring iCloud. Moving one to another day genuinely changes the event, and
 * there is no write path to the calendar, so that detaches a local copy the same way
 * dragging on the calendar grid does.
 *
 * `days` is the board window the drop happened in, so the siblings read back
 * here are exactly the ones the user was looking at — a to-do dated before the
 * window is displayed in its first column, and reading a single day would miss
 * it.
 */
export function moveBoardItem(
  itemKey: string,
  fromYmd: string,
  toYmd: string,
  target: MoveTarget,
  days: string[],
  newLocalId?: string,
): MoveResult {
  const sameDay = fromYmd === toYmd;
  let key = itemKey;
  let detached = false;
  /** The date the position is stored against — a task's own, an event's column. */
  let orderYmd = toYmd;

  if (isTaskKey(itemKey)) {
    const id = itemKey.slice("task:".length);
    if (!sameDay) updateTask(id, { ymd: toYmd });
    // A carried-over to-do is shown in the first column but keeps its own date,
    // so a reorder there must not pretend it moved to today.
    orderYmd = sameDay ? taskYmd(id, toYmd) : toYmd;
  } else if (!sameDay) {
    // Cross-day: the event's date really changes, which for a feed event
    // means detaching a local copy.
    // Detaching changes the occurrence key; moveOccurrence carries the
    // Reminders link across itself, so the next sync updates that reminder
    // instead of creating a second one.
    const moved = moveOccurrence(itemKey, toYmd, undefined, newLocalId);
    clearPosition(fromYmd, itemKey);
    relinkNote(itemKey, moved.key);
    detached = moved.key !== itemKey;
    key = moved.key;
  }

  const { siblings, storageYmd } = siblingsFor(days, toYmd, key);
  const index =
    "index" in target
      ? Math.max(0, Math.min(target.index, siblings.length))
      : indexForNeighbours(
          siblings.map((s) => s.key),
          target.beforeKey,
          target.afterKey,
        );

  const placements = index === null ? null : placeForDrop(siblings, index, key);
  if (placements === null) {
    // Nothing to sort against, or the slot the user aimed at has gone: sort by
    // the clock again rather than invent a key.
    dropPosition(orderYmd, key);
    return { key, detached };
  }

  for (const p of placements) {
    // A respaced sibling may itself be a carried-over to-do, whose position
    // belongs under its own date rather than the column it is shown in.
    setPosition(p.key === key ? orderYmd : storageYmd.get(p.key) ?? toYmd, p.key, p.position);
  }
  if (isTaskKey(key)) clearOtherPositions(orderYmd, key);
  return { key, detached };
}

/** Forget an item's hand-set position wherever it was stored. */
function dropPosition(ymd: string, itemKey: string): void {
  if (isTaskKey(itemKey)) {
    db().prepare("DELETE FROM board_order WHERE item_key = ?").run(itemKey);
    return;
  }
  clearPosition(ymd, itemKey);
}

/** A task's own date, so a carried-over to-do's position is stored under it. */
function taskYmd(id: string, fallback: string): string {
  const row = db().prepare("SELECT ymd FROM tasks WHERE id = ?").get(id) as
    | { ymd: string }
    | undefined;
  return row?.ymd ?? fallback;
}

/**
 * The day's items as the board renders them, without the one being moved, plus
 * the date each one's position is stored under (its own, not the column, for a
 * carried-over to-do).
 */
function siblingsFor(
  days: string[],
  column: string,
  key: string,
): { siblings: Sibling[]; storageYmd: Map<string, string> } {
  if (days.length === 0) return { siblings: [], storageYmd: new Map() };
  const from = days[0];
  const to = days[days.length - 1];
  const byDay = buildBoardItems(days, getOccurrences(from, to), listTasks(from, to));
  const shown = (byDay[column] ?? []).filter((item) => item.key !== key);
  return {
    siblings: shown.map((item) => ({ key: item.key, order: item.order })),
    storageYmd: new Map(
      shown.map((item) => [
        item.key,
        item.kind === "task" ? item.task.ymd : item.occurrence.ymd,
      ]),
    ),
  };
}

/**
 * Set (or clear) an item's time without changing where it sits in the list.
 *
 * Retiming a feed event detaches a local copy, because the original is a
 * read-only mirror. Any hand-set position follows the item to its new key so
 * the list does not jump under the user.
 */
export function setItemTime(
  itemKey: string,
  ymd: string,
  startMin: number | null,
  newLocalId?: string,
): MoveResult {
  if (isTaskKey(itemKey)) {
    updateTask(itemKey.slice("task:".length), { startMin });
    return { key: itemKey, detached: false };
  }

  if (itemKey.startsWith("local:")) {
    const id = itemKey.slice("local:".length);
    if (startMin === null) {
      updateLocalEvent(id, { startMin: null, endMin: null, allDay: true });
    } else {
      updateLocalEvent(id, { startMin, endMin: null, allDay: false });
    }
    return { key: itemKey, detached: false };
  }

  if (startMin === null) {
    throw new Error("A feed event cannot be made all-day here — edit it in Calendar.");
  }
  // The Reminders link follows inside moveOccurrence.
  const moved = moveOccurrence(itemKey, ymd, startMin, newLocalId);
  relinkNote(itemKey, moved.key);
  const existing = db()
    .prepare("SELECT position FROM board_order WHERE ymd = ? AND item_key = ?")
    .get(ymd, itemKey) as { position: number } | undefined;
  if (existing) {
    clearPosition(ymd, itemKey);
    setPosition(ymd, moved.key, existing.position);
  }
  return { key: moved.key, detached: moved.key !== itemKey };
}

/**
 * Put an item after everything already on its day.
 *
 * For a to-do typed into Reminders on the phone: it sits at the bottom of the
 * list there, so it goes at the bottom of the day here too. Left on its default
 * key it would tie with every other untimed to-do and sort by id — somewhere
 * arbitrary — and the next Reminders pass, seeing the two orders disagree,
 * would delete and recreate the reminder the user had only just typed.
 */
export function placeLast(ymd: string, itemKey: string): void {
  const day = buildBoardItems([ymd], getOccurrences(ymd, ymd), listTasks(ymd, ymd))[ymd] ?? [];
  const others = day.filter((item) => item.key !== itemKey);
  if (others.length === 0) return;
  setPosition(ymd, itemKey, others[others.length - 1].order + EDGE_GAP);
}

/* ------------------------------------------- between the board and backlog */

/**
 * A "Need to action" item dragged onto a board day becomes a to-do there, at
 * the slot it was dropped in. The backlog item goes in the same transaction,
 * so the thing is never in both places or neither; its notes follow it. The
 * Reminders mirror sees one delete and one new to-do, so the reminder moves
 * from the Need to Action list to Today on its own (when the day is today).
 *
 * `newTaskId` names the to-do it becomes (the phone mints it, so its queue can
 * refer to the to-do at once); a fresh id otherwise.
 */
export function moveActionToBoard(
  actionId: string,
  toYmd: string,
  target: MoveTarget,
  days: string[],
  newTaskId?: string,
): { key: string } {
  const conn = db();
  return conn.transaction(() => {
    const action = conn
      .prepare("SELECT title FROM action_items WHERE id = ?")
      .get(actionId) as { title: string } | undefined;
    if (!action) throw new Error("That item is no longer in Need to action");
    const task = createTask({ ymd: toYmd, title: action.title, id: newTaskId });
    const key = taskKey(task.id);
    relinkNote(`action:${actionId}`, key);
    rememberMove(`action:${actionId}`, key);
    deleteAction(actionId);
    moveBoardItem(key, toYmd, toYmd, target, days);
    return { key };
  })();
}

/**
 * A to-do dragged into "Need to action" leaves its day and joins the backlog
 * at the slot it was dropped in, keeping its title and notes. It loses its day
 * and time — the backlog is undated by definition — so a timed to-do's
 * calendar event goes too (the mirror removes it while it is still ahead). Only
 * to-dos: an event belongs to its calendar and its day. `newActionId` names
 * the backlog row it becomes, as `newTaskId` does above.
 */
export function moveTaskToBacklog(
  itemKey: string,
  target: ActionMoveTarget,
  newActionId?: string,
): { id: string } {
  if (!isTaskKey(itemKey)) {
    throw new Error("Only to-dos can go to Need to action — an event stays on its day");
  }
  const conn = db();
  return conn.transaction(() => {
    const task = getTask(itemKey.slice("task:".length));
    if (!task) throw new Error("That to-do is no longer on the board");
    const action = createAction(task.title, newActionId);
    relinkNote(itemKey, `action:${action.id}`);
    rememberMove(itemKey, `action:${action.id}`);
    deleteTask(task.id);
    // Neighbours that have gone leave it at the bottom, where createAction put it.
    moveAction(action.id, target);
    return { id: action.id };
  })();
}

/**
 * Where an item that crossed between the board and the backlog went. The row
 * is deleted and a new one made under another key; an edit queued on the
 * phone against the old key (a note typed before the Mac's move reached it)
 * follows this to the new row instead of being dropped as "deleted".
 */
const movedKey = (key: string) => `item.moved.${key}`;

export function rememberMove(fromKey: string, toKey: string): void {
  setMeta(movedKey(fromKey), toKey);
}

/** The key `key` became by moving to or from the backlog, following later moves; null if it never moved. */
export function movedTo(key: string): string | null {
  let at = key;
  for (let hop = 0; hop < 8; hop++) {
    const next = getMeta(movedKey(at));
    if (!next || next === key) break;
    at = next;
  }
  return at === key ? null : at;
}

/**
 * Put `keys` in that order within a day, leaving every other item where it is.
 *
 * For the Reminders mirror: the user dragged the day's list into a new order
 * on the phone, and the board follows. Each item that sits above its
 * predecessor is dropped straight after it, exactly as a drag on the board
 * would drop it — so ties, carried-over to-dos and feed events are handled
 * by the same code, and only the items that are out of place get a new key.
 * Keys no longer on the day are skipped.
 */
export function reorderDay(ymd: string, keys: string[]): void {
  const shown = (): string[] =>
    (buildBoardItems([ymd], getOccurrences(ymd, ymd), listTasks(ymd, ymd))[ymd] ?? []).map(
      (item) => item.key,
    );
  const onDay = new Set(shown());
  const wanted = keys.filter((key) => onDay.has(key));
  for (let i = 1; i < wanted.length; i++) {
    const now = shown();
    if (now.indexOf(wanted[i]) > now.indexOf(wanted[i - 1])) continue;
    moveBoardItem(wanted[i], ymd, ymd, { beforeKey: wanted[i - 1], afterKey: null }, [ymd]);
  }
}

/** Drop the hand-set position so an item sorts by its time again. */
export function unpinBoardItem(ymd: string, itemKey: string): void {
  // A to-do has one position, stored under its own date, which is not
  // necessarily the column the × was clicked in.
  if (isTaskKey(itemKey)) {
    db().prepare("DELETE FROM board_order WHERE item_key = ?").run(itemKey);
    return;
  }
  clearPosition(ymd, itemKey);
}
