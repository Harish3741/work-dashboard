import test from "node:test";
import assert from "node:assert/strict";

/**
 * The line model behind a task's notes: typing "- " makes a tick-box, Enter
 * carries the list on, Enter on an empty box ends it, Backspace at the start of
 * a box unmakes it. Every rule lives in lib/checklist so it can be checked here
 * rather than by clicking around the panel.
 */
const {
  parseNotes,
  formatNotes,
  setText,
  splitLine,
  backspaceAtStart,
  toggle,
  checkCount,
  isEmpty,
  ensureLine,
  insertText,
  fieldValue,
  caretAt,
  positionOf,
  deleteRange,
  deleteForwardAtEnd,
  replaceRange,
  replaceRangeRaw,
  serializeRange,
  diffEdit,
  toggleLines,
  noteSummary,
  toggleCheck,
} = await import("../.test-build/checklist.js");

const text = (t) => ({ kind: "text", text: t });
const check = (t, done = false) => ({ kind: "check", text: t, done });

test("round-trips text and tick-boxes", () => {
  const body = "Ring the clinic\n- [ ] book it\n- [x] find referral";
  assert.deepEqual(parseNotes(body), [
    text("Ring the clinic"),
    check("book it"),
    check("find referral", true),
  ]);
  assert.equal(formatNotes(parseNotes(body)), body);
});

test("an empty note is no lines, and gets one to type into", () => {
  assert.deepEqual(parseNotes(""), []);
  assert.deepEqual(ensureLine([]), [text("")]);
  assert.deepEqual(ensureLine([check("a")]), [check("a")]);
});

test("a capital X is still ticked, and odd spacing still parses", () => {
  assert.deepEqual(parseNotes("- [X] shouted"), [check("shouted", true)]);
  assert.deepEqual(parseNotes("*  [ ]  starred"), [check(" starred")]);
});

test("a line that only mentions a dash is not a tick-box", () => {
  assert.deepEqual(parseNotes("well-behaved"), [text("well-behaved")]);
  assert.deepEqual(parseNotes("2 - 3 = -1"), [text("2 - 3 = -1")]);
});

test("typing '- ' turns the line into a tick-box and eats the marker", () => {
  // Caret sits after the two characters just typed.
  const edit = setText([text("")], 0, "- ", 2);
  assert.deepEqual(edit.lines, [check("")]);
  assert.deepEqual(edit.caret, { index: 0, offset: 0 }, "caret follows the eaten marker");
});

test("typing '- ' in front of existing words converts and keeps them", () => {
  const edit = setText([text("milk")], 0, "- milk", 2);
  assert.deepEqual(edit.lines, [check("milk")]);
  assert.deepEqual(edit.caret, { index: 0, offset: 0 });
});

test("a dash typed inside a tick-box stays a dash", () => {
  const edit = setText([check("buy")], 0, "- buy", 5);
  assert.deepEqual(edit.lines, [check("- buy")], "no nesting, no second conversion");
});

test("Enter on a tick-box makes another, unticked", () => {
  const edit = splitLine([check("first", true)], 0, 5);
  assert.deepEqual(edit.lines, [check("first", true), check("")]);
  assert.deepEqual(edit.caret, { index: 1, offset: 0 });
});

test("Enter mid-line splits the words across the two lines", () => {
  const edit = splitLine([check("buy milk")], 0, 3);
  assert.deepEqual(edit.lines, [check("buy"), check(" milk")]);
  assert.deepEqual(edit.caret, { index: 1, offset: 0 });
});

test("Enter on an empty tick-box ends the list instead of adding another", () => {
  const edit = splitLine([check("done"), check("")], 1, 0);
  assert.deepEqual(edit.lines, [check("done"), text("")]);
  assert.deepEqual(edit.caret, { index: 1, offset: 0 }, "stays put, now an ordinary line");
});

test("Enter at the start of a ticked box opens an unticked line above; the tick stays with the words", () => {
  const edit = splitLine([check("milk"), check("bread", true)], 1, 0);
  assert.deepEqual(edit.lines, [check("milk"), check(""), check("bread", true)]);
  assert.deepEqual(edit.caret, { index: 2, offset: 0 });
  assert.deepEqual(splitLine([check("bread", true)], 0, 2).lines, [check("br", true), check("ead")], "mid-line is unchanged");
});

test("Backspace at the start of a tick-box unmakes it and keeps the words", () => {
  const edit = backspaceAtStart([check("buy milk")], 0);
  assert.deepEqual(edit.lines, [text("buy milk")]);
  assert.deepEqual(edit.caret, { index: 0, offset: 0 });
});

test("Backspace at the start of an ordinary line joins it to the one above", () => {
  const edit = backspaceAtStart([text("hello"), text(" there")], 1);
  assert.deepEqual(edit.lines, [text("hello there")]);
  assert.deepEqual(edit.caret, { index: 0, offset: 5 }, "caret lands at the join");
});

test("Backspace on the very first line does nothing", () => {
  const lines = [text("hello")];
  const edit = backspaceAtStart(lines, 0);
  assert.deepEqual(edit.lines, lines);
});

test("ticking and unticking", () => {
  assert.deepEqual(toggle([check("a")], 0), [check("a", true)]);
  assert.deepEqual(toggle([check("a", true)], 0), [check("a")]);
  assert.deepEqual(toggle([text("a")], 0), [text("a")], "an ordinary line has nothing to tick");
});

test("counts drive the board row's marker", () => {
  assert.deepEqual(checkCount([text("x"), check("a", true), check("b")]), { done: 1, total: 2 });
  assert.deepEqual(checkCount([text("just words")]), { done: 0, total: 0 });
});

test("a note of empty boxes is still empty, so it is not stored", () => {
  assert.equal(isEmpty(parseNotes("")), true);
  assert.equal(isEmpty([text(""), check("")]), true);
  assert.equal(isEmpty([text("   ")]), true);
  assert.equal(isEmpty([check("buy milk")]), false);
});

test("a whole session of typing survives the round trip", () => {
  // Type "Plan", Enter, "- ", "milk", Enter, "eggs", tick the first box.
  let lines = ensureLine([]);
  lines = setText(lines, 0, "Plan", 4).lines;
  lines = splitLine(lines, 0, 4).lines;
  lines = setText(lines, 1, "- ", 2).lines;
  lines = setText(lines, 1, "milk", 4).lines;
  lines = splitLine(lines, 1, 4).lines;
  lines = setText(lines, 2, "eggs", 4).lines;
  lines = toggle(lines, 1);

  assert.equal(formatNotes(lines), "Plan\n- [x] milk\n- [ ] eggs");
  assert.deepEqual(parseNotes(formatNotes(lines)), lines, "reopens exactly as it was left");
});

test("a plain line that already starts with a dash is not re-converted", () => {
  // Only the edit that introduces the marker converts; otherwise a line whose
  // words happen to begin "- " would turn into a box on any later keystroke.
  const line = [text("- already text")];
  const edit = setText(line, 0, "- already texts", 15);
  assert.deepEqual(edit.lines, [text("- already texts")], "stays an ordinary line");
});

test("pasting several lines keeps them as several lines", () => {
  const edit = insertText([text("")], 0, 0, "one\ntwo\nthree");
  assert.deepEqual(edit.lines, [text("one"), text("two"), text("three")]);
  assert.deepEqual(edit.caret, { index: 2, offset: 5 }, "caret at the end of what was pasted");
});

test("pasting a written-out checklist arrives as real tick-boxes", () => {
  const edit = insertText([text("")], 0, 0, "Shopping\n- [x] milk\n- eggs\r\n- [ ] bread");
  assert.deepEqual(edit.lines, [
    text("Shopping"),
    check("milk", true),
    check("eggs"),
    check("bread"),
  ]);
});

test("pasting into the middle of a line splits it around the paste", () => {
  const edit = insertText([text("abcd")], 0, 2, "X\nY");
  assert.deepEqual(edit.lines, [text("abX"), text("Ycd")]);
  assert.deepEqual(edit.caret, { index: 1, offset: 1 }, "caret sits after what was pasted");
});

test("a single-line paste behaves like typing", () => {
  const edit = insertText([text("ab")], 0, 1, "XY");
  assert.deepEqual(edit.lines, [text("aXYb")]);
});

/**
 * The single notes field: one textarea holding the line texts joined by "\n",
 * mapped back onto lines. What survives a selection across lines, what a copy
 * carries, and which of two repeated characters an edit removed are all decided
 * here, so none of it needs a browser to check.
 */
const L = [text("intro line"), check("first box"), check("second box", true), text("plain after"), check("last box")];
const at = (index, offset) => ({ index, offset });

test("the single field holds the words, never the markers", () => {
  assert.equal(fieldValue([text("a"), check("b", true), text("")]), "a\nb\n");
});

test("caretAt and positionOf round-trip every position in the field", () => {
  const v = fieldValue(L);
  for (let p = 0; p <= v.length; p++) assert.equal(positionOf(L, caretAt(L, p)), p);
  assert.deepEqual(caretAt(L, 10), at(0, 10), "end of a line is still that line");
  assert.deepEqual(caretAt(L, 11), at(1, 0), "one past the newline is the next line");
  assert.deepEqual(caretAt(L, 9999), at(4, 8), "past the end clamps to the end");
  assert.equal(positionOf([text("ab"), text("c")], at(0, 99)), 2, "an offset past the line clamps");
});

test("deleting inside one line keeps its box and tick", () => {
  const edit = deleteRange([check("hello", true)], at(0, 1), at(0, 4));
  assert.deepEqual(edit.lines, [check("ho", true)]);
  assert.deepEqual(edit.caret, at(0, 1));
});

test("a selection starting mid-line keeps the first line's kind", () => {
  assert.deepEqual(deleteRange(L, at(1, 3), at(3, 5)).lines, [text("intro line"), check("fir after"), check("last box")]);
  assert.deepEqual(deleteRange(L, at(3, 5), at(1, 3)).lines, deleteRange(L, at(1, 3), at(3, 5)).lines, "either order");
});

test("deleting whole lines never takes the next line's box", () => {
  assert.deepEqual(deleteRange(L, at(0, 0), at(2, 0)).lines, [check("second box", true), text("plain after"), check("last box")]);
  assert.deepEqual(deleteRange([text("a"), text("b"), check("")], at(1, 0), at(2, 0)).lines, [text("a"), check("")], "an empty box at the end of the selection survives");
});

test("from a line start into a later line, the later line's box survives", () => {
  assert.deepEqual(deleteRange(parseNotes("top\nplain\n- [x] checked"), at(1, 0), at(2, 3)).lines, [text("top"), check("cked", true)]);
  assert.deepEqual(deleteRange(L, at(1, 0), at(3, 6)).lines, [text("intro line"), text("after"), check("last box")]);
});

test("emptying both end lines keeps the first line's kind", () => {
  assert.deepEqual(deleteRange([text("x"), check("a"), text("b"), text("y")], at(1, 0), at(2, 1)).lines, [text("x"), check(""), text("y")]);
});

test("selecting the whole note and deleting leaves one plain line", () => {
  const edit = deleteRange([check("a", true), check("b")], at(0, 0), at(1, 1));
  assert.deepEqual(edit.lines, [text("")]);
  assert.deepEqual(edit.caret, at(0, 0));
});

test("Delete at a line end joins the next line into it", () => {
  const edit = deleteForwardAtEnd([check("a", true), text("b")], 0);
  assert.deepEqual(edit.lines, [check("ab", true)]);
  assert.deepEqual(edit.caret, at(0, 1));
});

test("Delete on an empty plain line removes it and leaves the box below alone", () => {
  const edit = deleteForwardAtEnd([text(""), check("b", true)], 0);
  assert.deepEqual(edit.lines, [check("b", true)]);
  assert.deepEqual(edit.caret, at(0, 0));
});

test("Delete at the very end of the note does nothing", () => {
  const lines = [text("a")];
  assert.deepEqual(deleteForwardAtEnd(lines, 0).lines, lines);
});

test("replaceRange keeps the '- ' rule for a same-line edit", () => {
  const edit = replaceRange([text("-milk")], at(0, 1), at(0, 1), " ");
  assert.deepEqual(edit.lines, [check("milk")]);
  assert.deepEqual(edit.caret, at(0, 0));
});

test("typing over a multi-line selection replaces it", () => {
  const edit = replaceRange(parseNotes("one\n- [ ] two\nthree"), at(0, 1), at(2, 2), "Z");
  assert.equal(formatNotes(edit.lines), "oZree");
  assert.deepEqual(edit.caret, at(0, 2));
});

test("pasting a written list over a selection makes real boxes", () => {
  const edit = replaceRange(parseNotes("keep\n- [ ] gone1\ngone2\nend"), at(1, 0), at(3, 0), "- [ ] n1\n- [x] n2\n", { paste: true });
  assert.equal(formatNotes(edit.lines), "keep\n- [ ] n1\n- [x] n2\nend");
});

test("a multi-line paste into the middle of a line drops the first marker", () => {
  const edit = replaceRange([text("hello world")], at(0, 5), at(0, 5), "- [ ] a\n- [x] b", { paste: true });
  assert.equal(formatNotes(edit.lines), "helloa\n- [x] b world");
});

test("a one-line '- [x] item' pasted at a line start arrives as a ticked box", () => {
  const edit = replaceRange([text("")], at(0, 0), at(0, 0), "- [x] milk", { paste: true });
  assert.deepEqual(edit.lines, [check("milk", true)]);
  assert.deepEqual(edit.caret, at(0, 4));
  assert.deepEqual(replaceRange([text("ab")], at(0, 1), at(0, 1), "- [x] milk", { paste: true }).lines, [text("a- [x] milkb")], "mid-line it is just text");
});

test("replaceRangeRaw mirrors the field exactly and applies no rules", () => {
  const r = replaceRangeRaw(L, at(1, 3), at(2, 2), "A\n- [ ] B\nC");
  assert.equal(fieldValue(r.lines), "intro line\nfirA\n- [ ] B\nCcond box\nplain after\nlast box");
  assert.deepEqual(replaceRangeRaw([text("-")], at(0, 1), at(0, 1), " ").lines, [text("- ")], "no conversion");
});

test("copying within one line is plain text, even a whole box line", () => {
  assert.equal(serializeRange(L, at(1, 0), at(1, 9)), "first box");
});

test("copying across lines carries the markers of lines whose start is selected", () => {
  assert.equal(serializeRange(L, at(0, 6), at(4, 4)), "line\n- [ ] first box\n- [x] second box\nplain after\n- [ ] last");
  assert.equal(serializeRange(L, at(1, 6), at(3, 0)), "box\n- [x] second box\n");
});

test("cut then paste at the same caret restores the note exactly", () => {
  for (const [f, t] of [[at(0, 6), at(4, 4)], [at(1, 0), at(3, 0)], [at(1, 2), at(2, 3)], [at(0, 0), at(4, 8)]]) {
    const clip = serializeRange(L, f, t);
    const cut = deleteRange(L, f, t);
    assert.deepEqual(replaceRange(cut.lines, cut.caret, cut.caret, clip, { paste: true }).lines, L, JSON.stringify([f, t]));
  }
});

test("copy from one note and paste into another restores boxes and ticks", () => {
  const source = parseNotes("intro\n- [ ] a\n- [x] b\nplain\n");
  const clip = serializeRange(source, at(1, 0), at(3, 0));
  const edit = replaceRange(parseNotes("x\n"), at(1, 0), at(1, 0), clip, { paste: true });
  assert.equal(formatNotes(edit.lines), "x\n- [ ] a\n- [x] b\n");
});

test("a whole copied line pasted at the start of another box keeps that box and its tick", () => {
  const lines = parseNotes("- [ ] milk\n- [ ] eggs\n- [x] bread");
  // A triple-click on "milk" selects up to the start of the next line.
  const clip = serializeRange(lines, caretAt(lines, 0), caretAt(lines, 5));
  assert.equal(clip, "- [ ] milk\n");
  const start = caretAt(lines, 10);
  const edit = replaceRange(lines, start, start, clip, { paste: true });
  assert.equal(formatNotes(edit.lines), "- [ ] milk\n- [ ] eggs\n- [ ] milk\n- [x] bread");
  assert.deepEqual(edit.caret, at(3, 0));

  const cut = deleteRange(parseNotes("- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d"), at(0, 0), at(2, 0));
  const moved = replaceRange(cut.lines, at(1, 0), at(1, 0), "- [ ] a\n- [ ] b\n", { paste: true });
  assert.equal(formatNotes(moved.lines), "- [ ] c\n- [ ] a\n- [ ] b\n- [ ] d", "cut lines moved in front of a box");
  const newline = replaceRange([check("milk", true)], at(0, 0), at(0, 0), "\n", { paste: true });
  assert.equal(formatNotes(newline.lines), "\n- [x] milk");
  const empty = replaceRange([check("")], at(0, 0), at(0, 0), "a\nb", { paste: true });
  assert.equal(formatNotes(empty.lines), "- [ ] a\nb", "into an empty box the first line still takes it");
});

test("a native replacement that keeps the line count keeps every line's box and tick", () => {
  // WebKit's Transformations › Capitalize sends one insertText for the whole selection.
  const lines = parseNotes("intro\n- [ ] milk\n- [ ] eggs\n- [x] bread\noutro");
  const value = "intro\nMilk\nEggs\nBread\noutro";
  const d = diffEdit(fieldValue(lines), value, 6, 21, false);
  const edit = replaceRange(lines, caretAt(lines, d.from), caretAt(lines, d.to), d.text);
  assert.equal(formatNotes(edit.lines), "intro\n- [ ] Milk\n- [ ] Eggs\n- [x] Bread\noutro");
  assert.equal(fieldValue(edit.lines), value, "the field keeps exactly what the browser wrote");
  const direct = replaceRange(lines, at(1, 0), at(3, 5), "Milk\nEggs\nBread");
  assert.deepEqual(direct.caret, at(3, 5));
});

test("diffEdit uses the selection to find which repeated character went", () => {
  assert.deepEqual(diffEdit("x\n\ny", "x\ny", 2, 2, false), { from: 2, to: 3, text: "" });
  assert.deepEqual(diffEdit("x\n\ny", "x\ny", 3, 3, true), { from: 2, to: 3, text: "" });
  assert.deepEqual(diffEdit("aa", "aaa", 1, 1, false), { from: 1, to: 1, text: "a" });
  assert.deepEqual(diffEdit("hello\nworld", "heZrld", 2, 8, false), { from: 2, to: 8, text: "Z" });
});

test("⌘↩ ticks every box on the selected lines, or unticks them if all are ticked", () => {
  const lines = [check("a"), text("b"), check("c", true)];
  const ticked = toggleLines(lines, 2, 0);
  assert.deepEqual(ticked, [check("a", true), text("b"), check("c", true)]);
  assert.deepEqual(toggleLines(ticked, 0, 2), [check("a"), text("b"), check("c")]);
  const plain = [text("x")];
  assert.equal(toggleLines(plain, 0, 0), plain, "no boxes, nothing changes");
});

test("noteSummary matches what the board and dashboard derive from storage", () => {
  assert.deepEqual(noteSummary(parseNotes("")), { hasNote: false, checks: null, items: [] });
  assert.deepEqual(noteSummary(parseNotes("   \n- [ ] ")), { hasNote: false, checks: null, items: [] }, "setNote deletes this");
  assert.deepEqual(noteSummary(parseNotes("words")), { hasNote: true, checks: null, items: [] });
  assert.deepEqual(noteSummary(parseNotes("- [x] a\n- [ ] b")), {
    hasNote: true,
    checks: { done: 1, total: 2 },
    items: [{ text: "a", done: true }, { text: "b", done: false }],
  });
});

test("a session typed through the single field survives the round trip", () => {
  let lines = ensureLine([]);
  lines = replaceRange(lines, at(0, 0), at(0, 0), "Plan").lines;
  lines = splitLine(lines, 0, 4).lines;
  lines = replaceRange(lines, at(1, 0), at(1, 0), "-").lines;
  lines = replaceRange(lines, at(1, 1), at(1, 1), " ").lines;
  lines = replaceRange(lines, at(1, 0), at(1, 0), "milk").lines;
  lines = splitLine(lines, 1, 4).lines;
  lines = replaceRange(lines, at(2, 0), at(2, 0), "eggs").lines;
  lines = toggle(lines, 1);
  assert.equal(formatNotes(lines), "Plan\n- [x] milk\n- [ ] eggs");
  assert.deepEqual(parseNotes(formatNotes(lines)), lines);
});

test("toggleCheck flips the nth box only, and refuses a stale one", () => {
  const lines = parseNotes("intro\n- [ ] a\nmiddle\n- [x] b");
  assert.equal(formatNotes(toggleCheck(lines, 1, "b")), "intro\n- [ ] a\nmiddle\n- [ ] b");
  assert.equal(formatNotes(toggleCheck(lines, 0, "a")), "intro\n- [x] a\nmiddle\n- [x] b");
  assert.equal(toggleCheck(lines, 0, "renamed"), null, "the words changed since the row was drawn");
  assert.equal(toggleCheck(lines, 2, "c"), null, "that box is gone");
});
