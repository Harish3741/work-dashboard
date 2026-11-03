import test from "node:test";
import assert from "node:assert/strict";

/**
 * When a page left open needs its data again. The window is usually already
 * frontmost when the lid closes, so the gap in the ticker is the only signal
 * that anything happened — these pin that it fires on a real wake and stays
 * quiet the rest of the time.
 */
const { decideWakeRefresh, WAKE_GAP_MS, WAKE_MIN_INTERVAL_MS } = await import(
  "../.test-build/wake.js"
);

const DAY = "2026-09-07";

/** One ordinary tick: both clocks advanced together, same day, nothing forced. */
function input(over = {}) {
  return {
    mark: { wall: 1_000_000, mono: 5_000 },
    now: { wall: 1_002_000, mono: 7_000 },
    todayOnScreen: DAY,
    todayNow: DAY,
    lastRefreshAt: 0,
    forced: false,
    busy: false,
    ...over,
  };
}

test("an awake machine never refetches", () => {
  const decision = decideWakeRefresh(input());
  assert.equal(decision.refresh, false);
  assert.equal(decision.defer, false);
});

test("a gap in the ticker is a wake", () => {
  // Neither clock ran: the laptop was shut.
  const gap = WAKE_GAP_MS + 1_000;
  const decision = decideWakeRefresh(
    input({ now: { wall: 1_000_000 + gap, mono: 5_000 + gap } }),
  );
  assert.equal(decision.refresh, true);
});

test("a wall clock that jumped past a monotonic one is a wake", () => {
  // The tick fired on time but hours of wall clock went by underneath it.
  const decision = decideWakeRefresh(
    input({ now: { wall: 1_000_000 + 8 * 3_600_000, mono: 7_000 } }),
  );
  assert.equal(decision.refresh, true);
});

test("midnight under an open lid is a wake", () => {
  const decision = decideWakeRefresh(input({ todayNow: "2026-09-08" }));
  assert.equal(decision.refresh, true, "the board is showing yesterday's rows");
});

test("the three events a wake fires together refetch once", () => {
  // visibilitychange, focus and online all arrive within a few milliseconds.
  const now = { wall: 1_000_000 + WAKE_GAP_MS + 1_000, mono: 5_000 };
  const first = decideWakeRefresh(input({ now, forced: true, lastRefreshAt: 0 }));
  assert.equal(first.refresh, true);

  const second = decideWakeRefresh(
    input({ now: { ...now, wall: now.wall + 10 }, forced: true, lastRefreshAt: now.wall }),
  );
  assert.equal(second.refresh, false, "inside the settle window");

  const later = decideWakeRefresh(
    input({
      now: { ...now, wall: now.wall + WAKE_MIN_INTERVAL_MS + 1 },
      forced: true,
      lastRefreshAt: now.wall,
    }),
  );
  assert.equal(later.refresh, true);
});

test("a drag holds the refetch, and it happens as soon as the drag ends", () => {
  const now = { wall: 1_000_000 + 8 * 3_600_000, mono: 7_000 };
  const held = decideWakeRefresh(input({ now, busy: true }));
  assert.equal(held.refresh, false, "never pull the board out from under the pointer");
  assert.equal(held.defer, true);

  // The caller re-asks with forced once the drag is done; the mark has moved on,
  // so only `forced` carries the wake through.
  const after = decideWakeRefresh(
    input({ mark: now, now: { wall: now.wall + 2_000, mono: 9_000 }, forced: true }),
  );
  assert.equal(after.refresh, true);
});

test("the mark always moves forward, so one wake is not reported twice", () => {
  const now = { wall: 1_000_000 + 8 * 3_600_000, mono: 7_000 };
  const decision = decideWakeRefresh(input({ now }));
  assert.deepEqual(decision.mark, now);

  const next = decideWakeRefresh(
    input({ mark: decision.mark, now: { wall: now.wall + 2_000, mono: 9_000 }, lastRefreshAt: now.wall }),
  );
  assert.equal(next.refresh, false);
});
