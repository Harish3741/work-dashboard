import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a dragged board item lands.
 *
 * The board's sort key is a number in start_min units, so two items very often
 * share one: every untimed to-do defaults to UNTIMED_ORDER, every all-day event
 * to ALL_DAY_ORDER, and any two events at the same clock time to that time.
 * Dropping between a tied pair used to write their own key back and the day
 * re-sorted on the key tie-break, so the item snapped home. These tests pin the
 * property that actually matters: after a drop, the day sorts in the order the
 * user dragged.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-board-order-"));
process.env.HABIT_DATA_DIR = dataDir;

// Reading a drop as "between these two" is shared with the backlog and covered
// in tests/actions-order.test.mjs; this file is the numbers it feeds.
const { placeForDrop, ALL_DAY_ORDER, UNTIMED_ORDER } = await import("../.test-build/board.js");

/** Apply placements to a day and return the keys in the order it now sorts. */
function resolve(siblings, placements, itemKey) {
  const written = new Map(placements.map((p) => [p.key, p.position]));
  const rows = [
    ...siblings.map((s) => ({ key: s.key, order: written.get(s.key) ?? s.order })),
    { key: itemKey, order: written.get(itemKey) },
  ];
  // The comparator from buildBoardItems, tie-break included.
  rows.sort((a, b) => (a.order === b.order ? a.key.localeCompare(b.key) : a.order - b.order));
  return rows.map((r) => r.key);
}

function assertStrictlyIncreasing(placements) {
  const sorted = [...placements].sort((a, b) => a.position - b.position);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].position > sorted[i - 1].position,
      `positions must be distinct, got ${sorted[i - 1].position} and ${sorted[i].position}`,
    );
  }
}

test("dropping between two untimed to-dos actually moves it", () => {
  // The live case: a day of to-dos with no time, all defaulting to 1500.
  const siblings = [
    { key: "task:a", order: UNTIMED_ORDER },
    { key: "task:b", order: UNTIMED_ORDER },
  ];
  const placements = placeForDrop(siblings, 1, "task:c");

  assert.equal(placements.length, 3, "the tied run is respaced, not just the dropped item");
  assertStrictlyIncreasing(placements);
  assert.deepEqual(resolve(siblings, placements, "task:c"), ["task:a", "task:c", "task:b"]);
});

test("respacing tied to-dos keeps them in the untimed zone", () => {
  // A real day: an all-day event far below, then a block of untimed to-dos.
  // Spreading the block down towards the all-day event would put these above
  // every timed event synced into the day afterwards.
  const siblings = [
    { key: "cal:allday", order: ALL_DAY_ORDER },
    { key: "task:a", order: UNTIMED_ORDER },
    { key: "task:b", order: UNTIMED_ORDER },
  ];
  const placements = placeForDrop(siblings, 2, "task:c");

  assertStrictlyIncreasing(placements);
  assert.deepEqual(resolve(siblings, placements, "task:c"), [
    "cal:allday",
    "task:a",
    "task:c",
    "task:b",
  ]);
  for (const p of placements) {
    assert.ok(
      Math.abs(p.position - UNTIMED_ORDER) <= 60,
      `${p.key} moved to ${p.position}, away from the untimed block`,
    );
    assert.ok(p.position > 24 * 60, `${p.key} at ${p.position} would sort inside the timed day`);
  }
});

test("a to-do dropped between two 9am events lands between them, not below both", () => {
  // "task:" sorts after every event key, so a tie sent it to the bottom.
  const siblings = [
    { key: "cal:x", order: 540 },
    { key: "cal:y", order: 540 },
  ];
  const placements = placeForDrop(siblings, 1, "task:z");

  assertStrictlyIncreasing(placements);
  assert.deepEqual(resolve(siblings, placements, "task:z"), ["cal:x", "task:z", "cal:y"]);
});

test("dropping between two all-day events works the same way", () => {
  const siblings = [
    { key: "cal:x", order: ALL_DAY_ORDER },
    { key: "cal:y", order: ALL_DAY_ORDER },
  ];
  const placements = placeForDrop(siblings, 1, "task:z");

  assertStrictlyIncreasing(placements);
  assert.deepEqual(resolve(siblings, placements, "task:z"), ["cal:x", "task:z", "cal:y"]);
});

test("a run of nine tied to-dos stays in order wherever the drop lands", () => {
  // 2026-09-04 and 2026-09-07 really did hold nine untimed to-dos each.
  const siblings = Array.from({ length: 9 }, (_, i) => ({
    key: `task:${i}`,
    order: UNTIMED_ORDER,
  }));
  for (let at = 0; at <= siblings.length; at++) {
    const placements = placeForDrop(siblings, at, "task:new");
    assertStrictlyIncreasing(placements);
    const expected = siblings.map((s) => s.key);
    expected.splice(at, 0, "task:new");
    assert.deepEqual(resolve(siblings, placements, "task:new"), expected, `at index ${at}`);
  }
});

test("an untied gap still writes one midpoint and rewrites nothing else", () => {
  const siblings = [
    { key: "cal:x", order: 540 },
    { key: "cal:y", order: 720 },
  ];
  const placements = placeForDrop(siblings, 1, "task:z");

  assert.deepEqual(placements, [{ key: "task:z", position: 630 }]);
});

test("the ends of a day leave room either side", () => {
  const siblings = [
    { key: "cal:x", order: 540 },
    { key: "cal:y", order: 720 },
  ];
  assert.deepEqual(placeForDrop(siblings, 0, "task:z"), [{ key: "task:z", position: 480 }]);
  assert.deepEqual(placeForDrop(siblings, 2, "task:z"), [{ key: "task:z", position: 780 }]);
});

test("an empty day pins nothing, so a later-synced event is not pushed below it", () => {
  assert.equal(placeForDrop([], 0, "task:z"), null);
});

test("repeated drops into the same gap never converge onto one key", () => {
  // Midpoints halve the gap; after enough of them the run is respaced instead.
  let siblings = [
    { key: "a", order: 540 },
    { key: "b", order: 600 },
  ];
  for (let i = 0; i < 40; i++) {
    const key = `k${i}`;
    const placements = placeForDrop(siblings, 1, key);
    assert.ok(placements, "a drop always resolves");
    const written = new Map(placements.map((p) => [p.key, p.position]));
    siblings = [...siblings.map((s) => ({ ...s, order: written.get(s.key) ?? s.order })), { key, order: written.get(key) }]
      .sort((a, b) => a.order - b.order);
    const orders = siblings.map((s) => s.order);
    assert.equal(new Set(orders).size, orders.length, `all keys distinct after drop ${i}`);
  }
});
