/**
 * The line model behind a task's notes.
 *
 * Notes are one block of text, and a line that starts with "- " is a tick-box.
 * Typing "- " at the start of a line turns it into one, Enter carries the list
 * on, Enter on an empty box ends it, and Backspace at the start of a box turns
 * it back into ordinary text — the way a checklist behaves in Google Docs.
 *
 * Stored as plain text rather than as rows, so the notes stay readable, survive
 * a hand edit of the database, and could be handed to Reminders or a Markdown
 * file later without a conversion:
 *
 *     Ring the clinic first
 *     - [ ] book the appointment
 *     - [x] find the referral
 *
 * Every operation here is pure and returns where the caret should end up, so
 * the editor component holds no rules of its own and the behaviour can be
 * tested without a browser. No React, no Next — the client imports this
 * directly, like lib/away.
 *
 * The editor is one textarea holding only the line texts joined by "\n" — the
 * markers never enter it. It maps onto this model through `caretAt` (a field
 * offset → line and offset), `diffEdit` (what the browser just changed, as one
 * range) and `replaceRange` (that change, with the same rules typing always had),
 * so a selection across lines is ordinary text to the browser and still lines
 * and boxes here.
 */

export type NoteLine =
  | { kind: "text"; text: string }
  | { kind: "check"; text: string; done: boolean };

/** Where the caret belongs after an edit: which line, and how far into it. */
export type Caret = { index: number; offset: number };

export type Edit = { lines: NoteLine[]; caret: Caret };

/** "- [ ] " or "- [x] " at the start of a line, however much space is used. */
const CHECK = /^[-*]\s+\[( |x|X)\]\s?(.*)$/;
/** What turns an ordinary line into a tick-box as you type it. */
const BULLET = /^[-*]\s(.*)$/;

export function parseNotes(body: string): NoteLine[] {
  if (body === "") return [];
  return body.split("\n").map((raw) => {
    const match = CHECK.exec(raw);
    if (!match) return { kind: "text", text: raw } as NoteLine;
    return { kind: "check", text: match[2], done: match[1].toLowerCase() === "x" };
  });
}

export function formatNotes(lines: NoteLine[]): string {
  return lines
    .map((line) =>
      line.kind === "check" ? `- [${line.done ? "x" : " "}] ${line.text}` : line.text,
    )
    .join("\n");
}

/** True once there is anything worth keeping — used to drop empty notes. */
export function isEmpty(lines: NoteLine[]): boolean {
  return lines.every((line) => line.text.trim() === "");
}

/** How many boxes there are and how many are ticked, for the row's marker. */
export function checkCount(lines: NoteLine[]): { done: number; total: number } {
  const boxes = lines.filter((line) => line.kind === "check");
  return { done: boxes.filter((l) => l.kind === "check" && l.done).length, total: boxes.length };
}

function replace(lines: NoteLine[], index: number, line: NoteLine): NoteLine[] {
  const next = [...lines];
  next[index] = line;
  return next;
}

/**
 * Text typed into one line.
 *
 * A plain line that now begins with "- " becomes a tick-box, and the marker is
 * eaten — so the two characters turn into a box rather than staying as text,
 * and the caret moves back by what was removed.
 */
export function setText(lines: NoteLine[], index: number, text: string, offset: number): Edit {
  const line = lines[index];
  if (!line) return { lines, caret: { index, offset } };

  if (line.kind === "text") {
    // Convert only when this edit *introduced* the marker. Testing the result
    // alone would re-convert a plain line that already happened to start with a
    // dash every time it was touched.
    const bullet = BULLET.exec(text);
    if (bullet && !BULLET.test(line.text)) {
      const eaten = text.length - bullet[1].length;
      return {
        lines: replace(lines, index, { kind: "check", text: bullet[1], done: false }),
        caret: { index, offset: Math.max(0, offset - eaten) },
      };
    }
    return { lines: replace(lines, index, { kind: "text", text }), caret: { index, offset } };
  }

  return {
    lines: replace(lines, index, { ...line, text }),
    caret: { index, offset },
  };
}

/**
 * Enter, splitting the line at the caret.
 *
 * On an empty tick-box it ends the list instead of adding another empty one —
 * pressing Enter twice is how you stop, and without this the only way out
 * would be to delete the box by hand.
 */
export function splitLine(lines: NoteLine[], index: number, offset: number): Edit {
  const line = lines[index];
  if (!line) return { lines, caret: { index, offset } };

  if (line.kind === "check" && line.text === "") {
    return {
      lines: replace(lines, index, { kind: "text", text: "" }),
      caret: { index, offset: 0 },
    };
  }

  const at = Math.max(0, Math.min(offset, line.text.length));
  const before = line.text.slice(0, at);
  const after = line.text.slice(at);
  // A new box carries on the list, unticked — its own state, not the one above.
  // At the very start of a box the new line opens ABOVE it, so the tick stays
  // with the words it belongs to rather than moving onto the empty line.
  const atStart = at === 0;
  const head: NoteLine =
    line.kind === "check"
      ? { kind: "check", text: before, done: atStart ? false : line.done }
      : { kind: "text", text: before };
  const tail: NoteLine =
    line.kind === "check"
      ? { kind: "check", text: after, done: atStart ? line.done : false }
      : { kind: "text", text: after };

  const next = [...lines];
  next.splice(index, 1, head, tail);
  return { lines: next, caret: { index: index + 1, offset: 0 } };
}

/**
 * Backspace at the very start of a line.
 *
 * On a tick-box that unmakes the box and keeps the words, which is what people
 * reach for first; only on an ordinary line does it join onto the one above.
 */
export function backspaceAtStart(lines: NoteLine[], index: number): Edit {
  const line = lines[index];
  if (!line) return { lines, caret: { index, offset: 0 } };

  if (line.kind === "check") {
    return {
      lines: replace(lines, index, { kind: "text", text: line.text }),
      caret: { index, offset: 0 },
    };
  }

  if (index === 0) return { lines, caret: { index: 0, offset: 0 } };

  const previous = lines[index - 1];
  const offset = previous.text.length;
  const merged: NoteLine =
    previous.kind === "check"
      ? { kind: "check", text: previous.text + line.text, done: previous.done }
      : { kind: "text", text: previous.text + line.text };

  const next = [...lines];
  next.splice(index - 1, 2, merged);
  return { lines: next, caret: { index: index - 1, offset } };
}

/** Tick or untick a box. Ordinary lines are left alone. */
export function toggle(lines: NoteLine[], index: number): NoteLine[] {
  const line = lines[index];
  if (!line || line.kind !== "check") return lines;
  return replace(lines, index, { ...line, done: !line.done });
}

/** An empty note still needs one line to type into. */
export function ensureLine(lines: NoteLine[]): NoteLine[] {
  return lines.length === 0 ? [{ kind: "text", text: "" }] : lines;
}

/**
 * Text dropped in at the caret — a paste.
 *
 * A pasted block is split into model lines here rather than left as newlines
 * inside one line, which is also what makes a list that is already written as
 * "- [ ] …" arrive as real tick-boxes rather than as the characters that spell one.
 */
export function insertText(
  lines: NoteLine[],
  index: number,
  offset: number,
  text: string,
): Edit {
  const line = lines[index];
  if (!line) return { lines, caret: { index, offset } };

  const chunks = text.split(/\r\n|\r|\n/);
  const at = Math.max(0, Math.min(offset, line.text.length));
  const before = line.text.slice(0, at);
  const after = line.text.slice(at);

  if (chunks.length === 1) {
    return setText(lines, index, before + chunks[0] + after, at + chunks[0].length);
  }

  // The line being pasted into keeps whatever it already was, on the chunk that
  // ends up holding its words: the first, unless the paste lands at the very
  // start of a line with words after it — they are in the last chunk then, and
  // giving the box to the first put it on the pasted text and left them plain.
  const owner = at === 0 && after !== "" ? chunks.length - 1 : 0;
  const made: NoteLine[] = chunks.map((chunk, i) => {
    const body = i === 0 ? before + chunk : i === chunks.length - 1 ? chunk + after : chunk;
    const written = CHECK.exec(body);
    if (written) {
      return { kind: "check", text: written[2], done: written[1].toLowerCase() === "x" };
    }
    const bullet = BULLET.exec(body);
    if (bullet) return { kind: "check", text: bullet[1], done: false };
    if (i === owner && line.kind === "check") {
      return { kind: "check", text: body, done: line.done };
    }
    return { kind: "text", text: body };
  });

  const next = [...lines];
  next.splice(index, 1, ...made);
  const last = made[made.length - 1];
  return {
    lines: next,
    caret: { index: index + made.length - 1, offset: Math.max(0, last.text.length - after.length) },
  };
}

/** A save's effect on the row marker — exactly what board.ts / dashboard.ts derive from storage. */
export type NoteSummary = {
  hasNote: boolean;
  checks: { done: number; total: number } | null;
  /** The boxes themselves, in order — the Goals tab lists them under the task. */
  items: CheckItem[];
};

export type CheckItem = { text: string; done: boolean };

/** The note's tick-boxes in order, words and tick only. */
export function checkItems(lines: NoteLine[]): CheckItem[] {
  return lines.flatMap((line) => (line.kind === "check" ? [{ text: line.text, done: line.done }] : []));
}

/**
 * Flips the `index`th tick-box (counting boxes only) — ticking a sub-task from
 * the row without opening the panel. Null when that box is gone or no longer
 * says `text`, so a stale row never ticks the wrong line.
 */
export function toggleCheck(lines: NoteLine[], index: number, text: string): NoteLine[] | null {
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind !== "check" || ++seen !== index) continue;
    if (line.text !== text) return null;
    return replace(lines, i, { ...line, done: !line.done });
  }
  return null;
}

/** The single notes field holds each line's words joined by "\n". Markers never enter it. */
export function fieldValue(lines: NoteLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/** An offset into fieldValue(lines) → which line, how far in. Past the end clamps to the end. */
export function caretAt(lines: NoteLine[], position: number): Caret {
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    const end = start + lines[index].text.length;
    if (position <= end) return { index, offset: Math.max(0, position - start) };
    start = end + 1;
  }
  const last = lines.length - 1;
  return { index: last, offset: lines[last].text.length };
}

/** The inverse of caretAt; an offset past its line's end is clamped to it. */
export function positionOf(lines: NoteLine[], caret: Caret): number {
  let position = 0;
  for (let i = 0; i < caret.index && i < lines.length; i++) position += lines[i].text.length + 1;
  const line = lines[caret.index];
  return position + Math.max(0, Math.min(caret.offset, line ? line.text.length : 0));
}

function ordered(a: Caret, b: Caret): [Caret, Caret] {
  return a.index < b.index || (a.index === b.index && a.offset <= b.offset) ? [a, b] : [b, a];
}

/** A line of the same kind (and tick) as `like`, holding `text`. */
function withText(like: NoteLine, text: string): NoteLine {
  return like.kind === "check" ? { kind: "check", text, done: like.done } : { kind: "text", text };
}

/**
 * Remove [from, to) — a selection deleted, cut or typed over.
 *
 * Within one line the line keeps its box and tick. Across lines, the joined line is:
 *   - the whole note selected                         → one plain empty line
 *   - some of the FIRST line survives (from mid-line) → the first line's kind
 *   - the selection ends at column 0, or some of the LAST line survives → the last line's kind
 *     (so deleting whole lines never takes the next line's box)
 *   - both end lines wholly consumed                  → the first line's kind
 */
export function deleteRange(lines: NoteLine[], from: Caret, to: Caret): Edit {
  const [a, b] = ordered(from, to);
  const first = lines[a.index];
  const last = lines[b.index];
  if (a.index === b.index) {
    const text = first.text.slice(0, a.offset) + first.text.slice(b.offset);
    return { lines: replace(lines, a.index, withText(first, text)), caret: { ...a } };
  }
  const head = first.text.slice(0, a.offset);
  const tail = last.text.slice(b.offset);
  const wholeNote =
    a.index === 0 && a.offset === 0 && b.index === lines.length - 1 && b.offset === last.text.length;
  const merged: NoteLine = wholeNote
    ? { kind: "text", text: "" }
    : withText(a.offset > 0 ? first : b.offset === 0 || tail !== "" ? last : first, head + tail);
  const next = [...lines];
  next.splice(a.index, b.index - a.index + 1, merged);
  return { lines: next, caret: { ...a } };
}

/**
 * Delete (forward) at the very end of a line.
 *
 * The line below joins it and takes its kind, as backspaceAtStart does from the
 * other side — except an empty plain line, which simply goes, so the box below
 * is not unmade. At the end of the note it does nothing.
 */
export function deleteForwardAtEnd(lines: NoteLine[], index: number): Edit {
  const line = lines[index];
  const below = lines[index + 1];
  if (!line || !below) return { lines, caret: { index, offset: line ? line.text.length : 0 } };
  const next = [...lines];
  if (line.kind === "text" && line.text === "") {
    next.splice(index, 1);
    return { lines: next, caret: { index, offset: 0 } };
  }
  next.splice(index, 2, withText(line, line.text + below.text));
  return { lines: next, caret: { index, offset: line.text.length } };
}

/**
 * Replace [from, to) with typed or pasted text, applying the checklist rules.
 *
 * - One line, no newline: setText, so typing "- " converts exactly as it always
 *   has. A paste of "- [ ] x" / "- [x] x" at the start of a plain line becomes
 *   that box, tick included — setText alone would make a box reading "[x] x".
 * - A typed (not pasted) text with as many lines as the range covers: line for
 *   line, each keeping its own box and tick.
 * - Otherwise deleteRange, then insertText (pasted markers become boxes). A
 *   multi-line paste landing mid-line drops the first chunk's marker — it can
 *   never be a box there.
 */
export function replaceRange(
  lines: NoteLine[],
  from: Caret,
  to: Caret,
  text: string,
  options: { paste?: boolean } = {},
): Edit {
  const [a, b] = ordered(from, to);
  const typed = text.replace(/\r\n?/g, "\n");
  if (a.index === b.index && !typed.includes("\n")) {
    const line = lines[a.index];
    const before = line.text.slice(0, a.offset);
    const after = line.text.slice(b.offset);
    const written = options.paste && before === "" && line.kind === "text" ? CHECK.exec(typed) : null;
    if (written) {
      return {
        lines: replace(lines, a.index, {
          kind: "check",
          text: written[2] + after,
          done: written[1].toLowerCase() === "x",
        }),
        caret: { index: a.index, offset: written[2].length },
      };
    }
    return setText(lines, a.index, before + typed + after, a.offset + typed.length);
  }
  // A native replacement with as many lines as it replaces — Transformations ›
  // Capitalize in WebKit sends one insertText for the whole selection — maps
  // line for line, so every line keeps its own box and tick. Through
  // deleteRange + insertText only the first line would. A paste still parses
  // its markers below.
  if (!options.paste && typed.includes("\n")) {
    const chunks = typed.split("\n");
    if (chunks.length === b.index - a.index + 1) {
      const next = [...lines];
      chunks.forEach((chunk, i) => {
        const line = lines[a.index + i];
        const head = i === 0 ? line.text.slice(0, a.offset) : "";
        const tail = i === chunks.length - 1 ? line.text.slice(b.offset) : "";
        next[a.index + i] = withText(line, head + chunk + tail);
      });
      return { lines: next, caret: { index: b.index, offset: chunks[chunks.length - 1].length } };
    }
  }
  const removed = deleteRange(lines, a, b);
  if (typed === "") return removed;
  if (!typed.includes("\n")) return replaceRange(removed.lines, removed.caret, removed.caret, typed, options);
  let inserted = typed;
  if (options.paste && removed.caret.offset > 0) {
    const newline = inserted.indexOf("\n");
    const written = CHECK.exec(inserted.slice(0, newline));
    if (written) inserted = written[2] + inserted.slice(newline);
  }
  return insertText(removed.lines, removed.caret.index, removed.caret.offset, inserted);
}

/**
 * The same replacement with NO rules: the model mirrors exactly what the field
 * now holds. Used while an IME is composing — rewriting the field then breaks
 * the composition — and as the undo step recorded just before a rule rewrites
 * the field, so undo gives back the literal "- " that was typed. New lines are plain.
 */
export function replaceRangeRaw(lines: NoteLine[], from: Caret, to: Caret, text: string): Edit {
  const removed = deleteRange(lines, from, to);
  const line = removed.lines[removed.caret.index];
  const before = line.text.slice(0, removed.caret.offset);
  const after = line.text.slice(removed.caret.offset);
  const chunks = text.replace(/\r\n?/g, "\n").split("\n");
  const made = chunks.map((chunk, i): NoteLine => {
    const body = (i === 0 ? before : "") + chunk + (i === chunks.length - 1 ? after : "");
    return i === 0 ? withText(line, body) : { kind: "text", text: body };
  });
  const next = [...removed.lines];
  next.splice(removed.caret.index, 1, ...made);
  const last = chunks.length - 1;
  return {
    lines: next,
    caret: { index: removed.caret.index + last, offset: (last === 0 ? before.length : 0) + chunks[last].length },
  };
}

/**
 * What copying [from, to) puts on the clipboard.
 *
 * Within one line: the plain characters, never a marker — a phrase lifted out of
 * a line should not drag "- [ ] " into another app. Across lines: every line
 * whose START is inside the selection carries "- [ ] " / "- [x] ", so pasting it
 * back restores the boxes; the last line only if some of it is taken.
 */
export function serializeRange(lines: NoteLine[], from: Caret, to: Caret): string {
  const [a, b] = ordered(from, to);
  if (a.index === b.index) return lines[a.index].text.slice(a.offset, b.offset);
  const out: string[] = [];
  for (let i = a.index; i <= b.index; i++) {
    const line = lines[i];
    const s = i === a.index ? a.offset : 0;
    const e = i === b.index ? b.offset : line.text.length;
    const marker = line.kind === "check" && s === 0 && !(i === b.index && e === 0);
    out.push((marker ? `- [${line.kind === "check" && line.done ? "x" : " "}] ` : "") + line.text.slice(s, e));
  }
  return out.join("\n");
}

/**
 * A native edit recovered as one range replacement.
 *
 * The common prefix and suffix of the old and new values, clamped by the
 * selection captured at beforeinput — without that, deleting one of two
 * repeated characters ("\n\n", "aa") is ambiguous, and picking the wrong one
 * joins the wrong lines. A backward delete anchors the suffix first, since the
 * removed text ends at the caret.
 */
export function diffEdit(
  prev: string,
  next: string,
  selStart: number | null,
  selEnd: number | null,
  backward: boolean,
): { from: number; to: number; text: string } {
  const known = selStart !== null && selEnd !== null;
  let p = 0;
  let s = 0;
  const prefix = (limit: number) => {
    while (p < limit && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  };
  const suffix = (limit: number) => {
    while (s < limit && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  };
  if (backward) {
    suffix(Math.min(next.length, prev.length, known ? prev.length - selEnd! : Infinity));
    prefix(Math.min(prev.length - s, next.length - s, known ? selStart! : Infinity));
  } else {
    prefix(Math.min(prev.length, next.length, known ? selStart! : Infinity));
    suffix(Math.min(prev.length - p, next.length - p, known ? prev.length - selEnd! : Infinity));
  }
  return { from: p, to: prev.length - s, text: next.slice(p, next.length - s) };
}

/**
 * ⌘↩: tick every box on lines from..to (either order) — or untick them all if
 * all are already ticked. The boxes are mouse-only buttons, so this is the
 * keyboard's way to them. No boxes in range returns the same array.
 */
export function toggleLines(lines: NoteLine[], from: number, to: number): NoteLine[] {
  const boxes: number[] = [];
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (lines[i]?.kind === "check") boxes.push(i);
  if (boxes.length === 0) return lines;
  const tick = boxes.some((i) => {
    const line = lines[i];
    return line.kind === "check" && !line.done;
  });
  const next = [...lines];
  for (const i of boxes) next[i] = { ...(next[i] as { kind: "check"; text: string; done: boolean }), done: tick };
  return next;
}

/**
 * The row marker a saved note produces, worked out on the client so a save can
 * patch the row instead of refetching the whole board or dashboard. A note of
 * blank lines and empty boxes is no note — setNote deletes it.
 */
export function noteSummary(lines: NoteLine[]): NoteSummary {
  if (isEmpty(lines)) return { hasNote: false, checks: null, items: [] };
  const counts = checkCount(lines);
  return { hasNote: true, checks: counts.total > 0 ? counts : null, items: checkItems(lines) };
}
