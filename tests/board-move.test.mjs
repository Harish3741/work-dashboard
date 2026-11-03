import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A drop, end to end: what moveBoardItem writes, and what buildBoardItems then
 * renders. The unit tests next door cover the arithmetic; these cover the two
 * things that made a correct number land in the wrong place — the storage date
 * of a carried-over to-do, and a client whose snapshot has gone stale.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-board-move-"));
process.env.HABIT_DATA_DIR = dataDir;

const {
  buildBoardItems,
  moveActionToBoard,
  moveBoardItem,
  moveTaskToBacklog,
  reorderDay,
  unpinBoardItem,
  taskKey,
} = await import("../.test-build/board.js");
const { createAction, createTask, getTask, listActions, listTasks } = await import(
  "../.test-build/store.js"
);
const { getNote, setNote } = await import("../.test-build/notes.js");
const { db } = await import("../.test-build/db.js");

const DAYS = Array.from({ length: 7 }, (_, i) => `2026-09-0${i + 1}`);
const DAY = "2026-09-03";

beforeEach(() => {
  const conn = db();
  conn.prepare("DELETE FROM tasks").run();
  conn.prepare("DELETE FROM board_order").run();
  conn.prepare("DELETE FROM action_items").run();
  conn.prepare("DELETE FROM item_notes").run();
});

/** The keys of one column, in the order the board renders them. */
function column(days, ymd) {
  const items = buildBoardItems(days, [], listTasks(days[0], days[days.length - 1]));
  return (items[ymd] ?? []).map((i) => i.key);
}

function positions() {
  return db().prepare("SELECT ymd, item_key, position FROM board_order ORDER BY ymd, position").all();
}

test("dragging an untimed to-do up the list keeps it there after the refetch", () => {
  createTask({ ymd: DAY, title: "Chapter 6" });
  createTask({ ymd: DAY, title: "Coherence" });
  createTask({ ymd: DAY, title: "Past papers" });
  // All three have no time, so all three default to the same sort key and the
  // rendered order is the key tie-break — whatever it happens to be.
  const [first, second, third] = column(DAYS, DAY);

  // Drop the bottom one between the top two, the way the client reports it.
  moveBoardItem(third, DAY, DAY, { beforeKey: first, afterKey: second }, DAYS);
  assert.deepEqual(column(DAYS, DAY), [first, third, second]);

  // A second drag straight after, before any refetch: this is what used to send
  // stale keys and land the item outside its neighbours.
  moveBoardItem(first, DAY, DAY, { beforeKey: second, afterKey: null }, DAYS);
  assert.deepEqual(column(DAYS, DAY), [third, second, first]);
});

test("a carried-over to-do keeps its position when the window rolls forward", () => {
  // Unfinished and dated before the window, so it shows in the first column.
  const old = createTask({ ymd: "2026-08-28", title: "Carried" });
  const same = createTask({ ymd: DAYS[0], title: "Today's" });
  const first = column(DAYS, DAYS[0]);
  assert.deepEqual(first, [taskKey(same.id), taskKey(old.id)].sort((x, y) => first.indexOf(x) - first.indexOf(y)));

  // Drag the carried one to the top of that column.
  moveBoardItem(taskKey(old.id), DAYS[0], DAYS[0], { beforeKey: null, afterKey: first[0] }, DAYS);
  assert.equal(column(DAYS, DAYS[0])[0], taskKey(old.id));

  // Tomorrow: the window starts a day later and it is still first.
  const rolled = DAYS.slice(1).concat("2026-09-08");
  assert.equal(column(rolled, rolled[0])[0], taskKey(old.id));

  // Exactly one row, stored under the task's own date rather than the column.
  const rows = positions().filter((r) => r.item_key === taskKey(old.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ymd, "2026-08-28");
});

test("moving a to-do to another day leaves no position behind", () => {
  const t = createTask({ ymd: DAY, title: "Gym" });
  const other = createTask({ ymd: "2026-09-04", title: "Shops" });
  moveBoardItem(taskKey(t.id), DAY, "2026-09-04", { beforeKey: taskKey(other.id), afterKey: null }, DAYS);

  const rows = positions().filter((r) => r.item_key === taskKey(t.id));
  assert.equal(rows.length, 1, "one row, under the new day");
  assert.equal(rows[0].ymd, "2026-09-04");
  assert.equal(listTasks(DAYS[0], DAYS.at(-1)).find((x) => x.id === t.id).ymd, "2026-09-04");
  assert.deepEqual(column(DAYS, "2026-09-04"), [taskKey(other.id), taskKey(t.id)]);
});

test("dropping onto an empty day pins nothing", () => {
  const t = createTask({ ymd: DAY, title: "Gym" });
  moveBoardItem(taskKey(t.id), DAY, "2026-09-05", { beforeKey: null, afterKey: null }, DAYS);

  assert.equal(positions().length, 0, "no hand-set position, so it still sorts by its time");
  const items = buildBoardItems(DAYS, [], listTasks(DAYS[0], DAYS.at(-1)));
  assert.equal(items["2026-09-05"][0].pinned, false);
});

test("a drop aimed at neighbours that have both gone clears the override", () => {
  const a = createTask({ ymd: DAY, title: "A" });
  const b = createTask({ ymd: DAY, title: "B" });
  moveBoardItem(taskKey(a.id), DAY, DAY, { beforeKey: taskKey(b.id), afterKey: null }, DAYS);
  assert.equal(positions().length, 1);

  moveBoardItem(taskKey(a.id), DAY, DAY, { beforeKey: "task:gone", afterKey: "task:also-gone" }, DAYS);
  assert.equal(positions().length, 0, "sort by the clock again rather than invent a slot");
});

test("unpinning a carried-over to-do finds its row under its own date", () => {
  const old = createTask({ ymd: "2026-08-28", title: "Carried" });
  createTask({ ymd: DAYS[0], title: "Today's" });
  const first = column(DAYS, DAYS[0]);
  moveBoardItem(taskKey(old.id), DAYS[0], DAYS[0], { beforeKey: null, afterKey: first[0] }, DAYS);
  assert.equal(positions().length, 1);

  unpinBoardItem(DAYS[0], taskKey(old.id));
  assert.equal(positions().length, 0);
});

test("the phone's queued bare index still places an item", () => {
  const a = createTask({ ymd: DAY, title: "A" });
  const b = createTask({ ymd: DAY, title: "B" });
  const c = createTask({ ymd: DAY, title: "C" });
  const before = column(DAYS, DAY);

  moveBoardItem(before[2], DAY, DAY, { index: 1 }, DAYS);
  assert.deepEqual(column(DAYS, DAY), [before[0], before[2], before[1]]);
});

/* ------------------------------------------- following a drag on the phone */

test("reorderDay puts the phone's order on the day", () => {
  for (const t of ["A", "B", "C", "D"]) createTask({ ymd: DAY, title: t });
  const [a, b, c, d] = column([DAY], DAY);

  reorderDay(DAY, [d, a, b, c]);
  assert.deepEqual(column([DAY], DAY), [d, a, b, c]);

  // Already in order: nothing is rewritten.
  const before = positions();
  reorderDay(DAY, [d, a, b, c]);
  assert.deepEqual(positions(), before);
});

test("reorderDay leaves items the phone does not show where they are", () => {
  for (const t of ["A", "B", "C"]) createTask({ ymd: DAY, title: t });
  const [a, b, c] = column([DAY], DAY);

  // The phone lists only a and c (b is, say, still pending in the inbox).
  reorderDay(DAY, [c, a]);
  const after = column([DAY], DAY);
  assert.ok(after.indexOf(c) < after.indexOf(a), "c now above a");
  assert.equal(after.length, 3);
  assert.ok(after.includes(b));
});

test("reorderDay places a carried-over to-do under its own date", () => {
  const old = createTask({ ymd: "2026-08-30", title: "Old" });
  createTask({ ymd: DAY, title: "Today" });
  const [first, second] = column([DAY], DAY);

  reorderDay(DAY, [second, first]);
  assert.deepEqual(column([DAY], DAY), [second, first]);
  for (const row of positions()) {
    if (row.item_key === taskKey(old.id)) assert.equal(row.ymd, "2026-08-30");
  }
});

test("reorderDay skips keys no longer on the day", () => {
  for (const t of ["A", "B"]) createTask({ ymd: DAY, title: t });
  const [a, b] = column([DAY], DAY);
  reorderDay(DAY, ["task:gone", b, a]);
  assert.deepEqual(column([DAY], DAY), [b, a]);
});

/* ------------------------------------ between the board and Need to action */

test("a backlog item dropped on a day becomes a to-do in that slot", () => {
  // Timed, so a to-do that was not placed would sort below both (untimed goes last).
  createTask({ ymd: DAY, title: "A", startMin: 540 });
  createTask({ ymd: DAY, title: "B", startMin: 600 });
  const [a, b] = column([DAY], DAY);
  const action = createAction("Call the bank");
  setNote(`action:${action.id}`, "- [ ] ask about fees");

  const { key } = moveActionToBoard(action.id, DAY, { beforeKey: a, afterKey: b }, [DAY]);

  assert.deepEqual(column([DAY], DAY), [a, key, b], "between the two it was dropped between");
  assert.equal(getTask(key.slice("task:".length)).title, "Call the bank");
  assert.deepEqual(listActions(), [], "gone from the backlog");
  assert.equal(getNote(key), "- [ ] ask about fees", "its notes came with it");
});

test("a to-do dropped into the backlog joins it in that slot", () => {
  const [x, y] = [createAction("X"), createAction("Y")];
  const task = createTask({ ymd: DAY, title: "Renew passport", startMin: 600 });
  const key = taskKey(task.id);
  setNote(key, "photos first");

  const { id } = moveTaskToBacklog(key, { beforeId: x.id, afterId: y.id });

  assert.deepEqual(listActions().map((a) => a.title), ["X", "Renew passport", "Y"]);
  assert.equal(getTask(task.id), null, "gone from the board");
  assert.equal(getNote(`action:${id}`), "photos first");
  assert.equal(positions().length, 0, "no position left behind");
});

test("an event cannot go to the backlog", () => {
  assert.throws(() => moveTaskToBacklog("local:abc", { beforeId: null, afterId: null }), /Only to-dos/);
  assert.throws(() => moveTaskToBacklog("ics:cal:uid:2026-09-03", { beforeId: null, afterId: null }), /Only to-dos/);
  assert.deepEqual(listActions(), []);
});

test("an item already gone either way changes nothing", () => {
  assert.throws(() => moveActionToBoard("missing", DAY, { beforeKey: null, afterKey: null }, [DAY]));
  assert.throws(() => moveTaskToBacklog("task:missing", { beforeId: null, afterId: null }));
  assert.deepEqual(listActions(), []);
  assert.deepEqual(column([DAY], DAY), []);
});
