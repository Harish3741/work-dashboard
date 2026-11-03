import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  addMonths,
  dayOfWeek,
  daysBetween,
  decideTimeCommit,
  endOfWeek,
  formatMinutes,
  clockFieldsOf,
  commitFor,
  monthGridDays,
  readClockFields,
  readTimeText,
  startOfWeek,
  toWallClock,
  weekDays,
} from "../.test-build/time.js";

test("weeks start on Monday", () => {
  // 2026-08-15 is a Saturday.
  assert.equal(dayOfWeek("2026-08-15"), 6);
  assert.equal(startOfWeek("2026-08-15"), "2026-08-10");
  assert.equal(endOfWeek("2026-08-15"), "2026-08-16");
  // Sunday belongs to the week that began the previous Monday.
  assert.equal(startOfWeek("2026-08-16"), "2026-08-10");
  // Monday is its own week start.
  assert.equal(startOfWeek("2026-08-10"), "2026-08-10");
});

test("day arithmetic crosses month and year boundaries", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29"); // leap year
  assert.equal(daysBetween("2026-08-10", "2026-08-15"), 5);
  assert.equal(daysBetween("2026-08-15", "2026-08-10"), -5);
});

test("month arithmetic clamps to the first of the month", () => {
  assert.equal(addMonths("2026-08-15", 1), "2026-09-01");
  assert.equal(addMonths("2026-01-15", -1), "2025-12-01");
  assert.equal(addMonths("2026-12-01", 1), "2027-01-01");
});

test("month grid covers whole Monday-start weeks", () => {
  const days = monthGridDays("2026-08-15");
  assert.equal(days.length % 7, 0);
  assert.equal(dayOfWeek(days[0]), 1); // Monday
  assert.equal(days[0], "2026-07-27"); // 1 Aug 2026 is a Saturday
  assert.equal(days.at(-1), "2026-09-06");
  assert.ok(days.includes("2026-08-01"));
  assert.ok(days.includes("2026-08-31"));
});

test("week view returns Monday through Sunday", () => {
  const days = weekDays("2026-08-15");
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-08-10");
  assert.equal(days[6], "2026-08-16");
});

test("wall-clock conversion honours the Sydney offset", () => {
  // AEST (UTC+10) in August.
  assert.deepEqual(toWallClock(new Date("2026-08-14T23:30:00Z"), "Australia/Sydney"), {
    ymd: "2026-08-15",
    minutes: 9 * 60 + 30,
  });
  // AEDT (UTC+11) in December.
  assert.deepEqual(toWallClock(new Date("2026-12-14T23:30:00Z"), "Australia/Sydney"), {
    ymd: "2026-12-15",
    minutes: 10 * 60 + 30,
  });
  // Local midnight must read as 0 minutes, not 1440.
  assert.deepEqual(toWallClock(new Date("2026-08-14T14:00:00Z"), "Australia/Sydney"), {
    ymd: "2026-08-15",
    minutes: 0,
  });
});

test("time formatting", () => {
  assert.equal(formatMinutes(null), "all-day");
  assert.equal(formatMinutes(0), "12 am");
  assert.equal(formatMinutes(9 * 60 + 5), "9:05 am");
  assert.equal(formatMinutes(12 * 60), "12 pm");
  assert.equal(formatMinutes(18 * 60 + 30), "6:30 pm");
});

/**
 * Closing the board's time editor.
 *
 * The rule exists because <input type="time"> reports an empty value for
 * anything incomplete — one Backspace on "09:30" blanks a segment and the
 * value becomes "" — so an abandoned edit is indistinguishable from a
 * deliberate clear. Before this, blurring a blanked field POSTed startMin:null
 * and destroyed the time.
 */
test("walking away from a blanked time keeps the time it had", () => {
  assert.deepEqual(decideTimeCommit("", 570, false), { action: "keep" });
});

test("walking away from a field that was blank to begin with does nothing", () => {
  assert.deepEqual(decideTimeCommit("", null, false), { action: "keep" });
});

test("Enter on a blank field is the one gesture that clears a time", () => {
  assert.deepEqual(decideTimeCommit("", 570, true), { action: "set", startMin: null });
});

test("Enter on a blank field with no time to clear does nothing", () => {
  assert.deepEqual(decideTimeCommit("", null, true), { action: "none" });
});

test("a complete time saves, whether committed by blur or by Enter", () => {
  assert.deepEqual(decideTimeCommit("09:30", null, false), { action: "set", startMin: 570 });
  assert.deepEqual(decideTimeCommit("14:45", 570, true), { action: "set", startMin: 885 });
});

test("re-committing the same time writes nothing", () => {
  assert.deepEqual(decideTimeCommit("09:30", 570, false), { action: "none" });
  assert.deepEqual(decideTimeCommit("09:30", 570, true), { action: "none" });
});

test("a value that is not a time is reported, not silently discarded", () => {
  // The field is a text box now, so the user can type anything. Saying nothing
  // was the original complaint: "I add a time and it doesn't save."
  assert.deepEqual(decideTimeCommit("half past nine", 570, true), { action: "invalid" });
  assert.deepEqual(decideTimeCommit("zzz", null, false), { action: "invalid" });
});

test("a bare hour is a time — the old control could not tell us this at all", () => {
  assert.deepEqual(decideTimeCommit("9", null, false), { action: "set", startMin: 540 });
  assert.deepEqual(decideTimeCommit("930", null, false), { action: "set", startMin: 570 });
  assert.deepEqual(decideTimeCommit("7pm", null, true), { action: "set", startMin: 1140 });
});

/**
 * The reader itself. Kept identical to the phone's parseTimeInput
 * (mobile/src/util/date.ts, mobile/tests/date.test.mjs) so a time typed on
 * either half of the app means the same thing.
 */
test("times can be typed the way people write them", () => {
  const at = (s) => readTimeText(s);
  assert.deepEqual(at("9:30"), { kind: "time", startMin: 570 });
  assert.deepEqual(at("0930"), { kind: "time", startMin: 570 });
  assert.deepEqual(at("930"), { kind: "time", startMin: 570 });
  assert.deepEqual(at("9"), { kind: "time", startMin: 540 });
  assert.deepEqual(at("21:30"), { kind: "time", startMin: 1290 });
  assert.deepEqual(at("7pm"), { kind: "time", startMin: 1140 });
  assert.deepEqual(at(" 7:05 PM "), { kind: "time", startMin: 1145 });
  assert.deepEqual(at("12am"), { kind: "time", startMin: 0 });
  assert.deepEqual(at("12pm"), { kind: "time", startMin: 720 });
  assert.deepEqual(at("00:00"), { kind: "time", startMin: 0 });
});

test("an empty field is empty, not invalid — the two mean different things", () => {
  assert.deepEqual(readTimeText(""), { kind: "empty" });
  assert.deepEqual(readTimeText("   "), { kind: "empty" });
});

test("things that are not times are rejected rather than guessed at", () => {
  for (const bad of ["25:00", "9:75", "abc", "9:3", "-1", "9pmm", "9 30 45", "::"]) {
    assert.deepEqual(readTimeText(bad), { kind: "invalid" }, `${JSON.stringify(bad)} should not read`);
  }
});

test("surrounding whitespace is not a value", () => {
  assert.deepEqual(decideTimeCommit("   ", 570, false), { action: "keep" });
  assert.deepEqual(decideTimeCommit("   ", 570, true), { action: "set", startMin: null });
});

test("midnight is a real time, not an absent one", () => {
  // 0 is falsy; a naive implementation drops it.
  assert.deepEqual(decideTimeCommit("00:00", null, false), { action: "set", startMin: 0 });
  assert.deepEqual(decideTimeCommit("00:00", 0, false), { action: "none" });
  assert.deepEqual(decideTimeCommit("", 0, true), { action: "set", startMin: null });
});

/**
 * The board's own hour / minute / am-pm fields. These exist because
 * <input type="time"> reports an empty value for anything incomplete, so an
 * entry missing its am/pm never reached the app at all.
 */
test("the commonest entry of all: an hour, no minutes", () => {
  assert.deepEqual(readClockFields("9", "", "am"), { kind: "time", startMin: 540 });
  assert.deepEqual(readClockFields("7", "", "pm"), { kind: "time", startMin: 1140 });
});

test("hour and minutes together", () => {
  assert.deepEqual(readClockFields("9", "30", "am"), { kind: "time", startMin: 570 });
  assert.deepEqual(readClockFields("9", "05", "pm"), { kind: "time", startMin: 1265 });
  assert.deepEqual(readClockFields("11", "59", "pm"), { kind: "time", startMin: 1439 });
});

test("12 am is midnight and 12 pm is noon", () => {
  assert.deepEqual(readClockFields("12", "00", "am"), { kind: "time", startMin: 0 });
  assert.deepEqual(readClockFields("12", "00", "pm"), { kind: "time", startMin: 720 });
  assert.deepEqual(readClockFields("12", "30", "am"), { kind: "time", startMin: 30 });
});

test("empty fields are empty, so walking away keeps the old time", () => {
  assert.deepEqual(readClockFields("", "", "am"), { kind: "empty" });
  assert.deepEqual(readClockFields("  ", "  ", "pm"), { kind: "empty" });
  assert.deepEqual(commitFor(readClockFields("", "", "am"), 570, false), { action: "keep" });
  assert.deepEqual(commitFor(readClockFields("", "", "am"), 570, true), { action: "set", startMin: null });
});

test("minutes with no hour is not a time — it is said out loud, not ignored", () => {
  assert.deepEqual(readClockFields("", "30", "am"), { kind: "invalid" });
  assert.deepEqual(commitFor(readClockFields("", "30", "am"), null, true), { action: "invalid" });
});

test("an hour outside 1-12 is rejected rather than guessed at", () => {
  for (const h of ["0", "13", "24", "99"]) {
    assert.deepEqual(readClockFields(h, "00", "am"), { kind: "invalid" }, `hour ${h}`);
  }
  assert.deepEqual(readClockFields("9", "60", "am"), { kind: "invalid" });
});

test("the fields round-trip a stored time", () => {
  assert.deepEqual(clockFieldsOf(null), { hour: "", minute: "", meridiem: "am" });
  assert.deepEqual(clockFieldsOf(570), { hour: "9", minute: "30", meridiem: "am" });
  assert.deepEqual(clockFieldsOf(1290), { hour: "9", minute: "30", meridiem: "pm" });
  assert.deepEqual(clockFieldsOf(0), { hour: "12", minute: "00", meridiem: "am" });
  assert.deepEqual(clockFieldsOf(720), { hour: "12", minute: "00", meridiem: "pm" });
  for (const m of [0, 1, 540, 570, 719, 720, 721, 1290, 1439]) {
    const f = clockFieldsOf(m);
    assert.deepEqual(readClockFields(f.hour, f.minute, f.meridiem), { kind: "time", startMin: m },
      `${m} should survive the round trip`);
  }
});
