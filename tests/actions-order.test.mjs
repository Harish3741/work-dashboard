import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Reordering the "Need to action" backlog. The sidebar sits open for days while
 * the 5-minute Reminders pass deletes rows ticked off on the phone, so a drop is
 * reported as the rows either side of the gap rather than as an index into a
 * list that has since moved.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-actions-order-"));
process.env.HABIT_DATA_DIR = dataDir;

const { createAction, deleteAction, listActions, moveAction, reorderActions } = await import(
  "../.test-build/store.js"
);
const { indexForNeighbours } = await import("../.test-build/order.js");
const { db } = await import("../.test-build/db.js");

beforeEach(() => {
  db().prepare("DELETE FROM action_items").run();
});

const titles = () => listActions().map((a) => a.title);

function seed(...names) {
  return names.map((name) => createAction(name));
}

test("dragging an item down lands it where it was dropped", () => {
  const [a, b, c, d, e] = seed("A", "B", "C", "D", "E");
  // A dropped between D and E.
  assert.equal(moveAction(a.id, { beforeId: d.id, afterId: e.id }), true);
  assert.deepEqual(titles(), ["B", "C", "D", "A", "E"]);
});

test("dragging an item up lands it where it was dropped", () => {
  const [a, b, c, d, e] = seed("A", "B", "C", "D", "E");
  // E dropped between A and B.
  assert.equal(moveAction(e.id, { beforeId: a.id, afterId: b.id }), true);
  assert.deepEqual(titles(), ["A", "E", "B", "C", "D"]);
});

test("a row deleted above the drop no longer drags the item too far", () => {
  const [a, b, c, d, e] = seed("A", "B", "C", "D", "E");
  // The phone ticked B off while the sidebar sat open showing all five.
  deleteAction(b.id);
  // The tab still thinks A is going to index 3; the neighbours say otherwise.
  assert.equal(moveAction(a.id, { beforeId: d.id, afterId: e.id }), true);
  assert.deepEqual(titles(), ["C", "D", "A", "E"]);
});

test("the ends of the list", () => {
  const [a, b, c] = seed("A", "B", "C");
  assert.equal(moveAction(c.id, { beforeId: null, afterId: a.id }), true);
  assert.deepEqual(titles(), ["C", "A", "B"]);
  assert.equal(moveAction(c.id, { beforeId: b.id, afterId: null }), true);
  assert.deepEqual(titles(), ["A", "B", "C"]);
});

test("a row that has gone is reported rather than silently renumbering", () => {
  const [a, b] = seed("A", "B");
  deleteAction(a.id);
  assert.equal(moveAction(a.id, { beforeId: b.id, afterId: null }), false);
  assert.deepEqual(titles(), ["B"]);
});

test("both neighbours gone leaves the list alone", () => {
  const [a, b, c] = seed("A", "B", "C");
  assert.equal(moveAction(a.id, { beforeId: "gone", afterId: "also-gone" }), false);
  assert.deepEqual(titles(), ["A", "B", "C"]);
});

test("the phone's queued bare index still works", () => {
  const [a, b, c] = seed("A", "B", "C");
  assert.equal(moveAction(a.id, { index: 2 }), true);
  assert.deepEqual(titles(), ["B", "C", "A"]);
});

test("positions stay dense from zero", () => {
  const [a, b, c] = seed("A", "B", "C");
  moveAction(c.id, { beforeId: null, afterId: a.id });
  assert.deepEqual(
    listActions().map((x) => x.position),
    [0, 1, 2],
  );
});

test("neighbour resolution is the same rule the board uses", () => {
  assert.equal(indexForNeighbours(["a", "b", "c"], "a", "b"), 1);
  assert.equal(indexForNeighbours(["a", "b", "c"], null, "a"), 0);
  assert.equal(indexForNeighbours(["a", "b", "c"], "c", null), 3);
  assert.equal(indexForNeighbours(["a", "b", "c"], "gone", "c"), 2);
  assert.equal(indexForNeighbours(["a", "b", "c"], "gone", "also-gone"), null);
});

test("reorderActions follows the phone's order, in the slots those items hold", () => {
  const [a, b, c, d] = seed("A", "B", "C", "D");
  // The phone shows a, c and d (b is pending in the inbox), dragged d to the top.
  reorderActions([d.id, a.id, c.id]);
  assert.deepEqual(titles(), ["D", "B", "A", "C"]);

  // Ids that have gone are skipped; already in order changes nothing.
  reorderActions(["gone", d.id, b.id, a.id, c.id]);
  assert.deepEqual(titles(), ["D", "B", "A", "C"]);
});
