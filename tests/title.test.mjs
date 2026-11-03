import test from "node:test";
import assert from "node:assert/strict";

/**
 * Renaming from the details panel. The title field is a textarea so a long
 * sentence wraps, but a title is one line; and an empty title puts the old one
 * back instead of deleting the task and its checklist.
 */
const { normaliseTitle, titleCommit } = await import("../.test-build/title.js");

test("a title is one trimmed line", () => {
  assert.equal(normaliseTitle("  a "), "a");
  assert.equal(normaliseTitle("a\nb"), "a b");
  assert.equal(normaliseTitle("a \r\n  b"), "a b");
  assert.equal(normaliseTitle(" \n "), "");
});

test("spaces and tabs inside a title are the user's and are kept", () => {
  assert.equal(normaliseTitle("a  b"), "a  b");
  assert.equal(normaliseTitle("a\tb"), "a\tb");
});

test("an empty title reverts rather than deleting", () => {
  assert.deepEqual(titleCommit("", "x"), { action: "revert" });
  assert.deepEqual(titleCommit("   ", "x"), { action: "revert" });
  assert.deepEqual(titleCommit("\n", "x"), { action: "revert" });
});

test("a draft that cleans up to the current title sends nothing", () => {
  assert.deepEqual(titleCommit("x", "x"), { action: "none" });
  assert.deepEqual(titleCommit("  x ", "x"), { action: "none" });
  assert.deepEqual(titleCommit("x\n", "x"), { action: "none" });
});

test("a changed title is saved cleaned up", () => {
  assert.deepEqual(titleCommit("y", "x"), { action: "save", title: "y" });
  assert.deepEqual(titleCommit(" y ", "x"), { action: "save", title: "y" });
  assert.deepEqual(titleCommit("a\nb", "x"), { action: "save", title: "a b" });
});

test("a change of case alone is a rename", () => {
  assert.deepEqual(titleCommit("X", "x"), { action: "save", title: "X" });
});
