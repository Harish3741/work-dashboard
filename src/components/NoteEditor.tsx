"use client";

import { memo, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  backspaceAtStart,
  caretAt,
  deleteForwardAtEnd,
  deleteRange,
  diffEdit,
  ensureLine,
  fieldValue,
  positionOf,
  replaceRange,
  replaceRangeRaw,
  serializeRange,
  setText,
  splitLine,
  toggle,
  toggleLines,
  type Caret,
  type NoteLine,
} from "@/lib/checklist";

/**
 * The notes editor: ONE textarea for the whole note, so a selection can run
 * from the middle of one line into another and be copied, cut, deleted or typed
 * over the way it can in any text box.
 *
 * The textarea holds only the line texts joined by "\n", and its glyphs are
 * transparent; the caret and the selection are visible and entirely the
 * browser's. Directly underneath, a backdrop draws the same lines, one div per
 * model line — that is where the tick-boxes (a button hung into its line's left
 * gutter) and the faint, struck-through ticked lines come from, all plain CSS,
 * nothing measured. It only works because both layers lay text out identically:
 * `.note-text` in globals.css, which nothing else may override.
 *
 * The textarea is uncontrolled. Most keystrokes are left to it and read back on
 * `input` (diffEdit → replaceRange), and its value is written only when a rule
 * actually changed the text — writing it on every keystroke moves the caret and
 * breaks IME composition. The editor itself only handles what changes the shape
 * of the note: Enter, Backspace at a line start, Delete at a line end, ticks,
 * and copy/cut/paste across lines. Every rule it applies lives in lib/checklist.
 *
 * Undo is the editor's own, taken on the ⌘Z keydown. Any write to `field.value`
 * wipes WebKit's undo stack, and in Habits.app the Edit menu's undo never
 * reaches a WKWebView anyway — measured: ⌘Z arrived as a keydown and native undo
 * did nothing.
 *
 * Listeners are native and attached once. React's onBeforeInput is synthetic and
 * has no inputType, and keydown → beforeinput → input have to run in exactly that
 * order against the same model.
 */

export type NoteEditorHandle = {
  /** Focus the note with the caret after its last character, scrolled into view. */
  focusEnd(): void;
};

type Props = {
  /** Read once, on mount. Render with `key={noteKey}` so a different note remounts. */
  initialLines: NoteLine[];
  /** Every model change, once it is on screen. */
  onChange: (lines: NoteLine[]) => void;
  ref?: React.Ref<NoteEditorHandle>;
};

/** A moment undo can go back to: the lines and the selection over them. */
type Snap = { lines: NoteLine[]; start: number; end: number };

const UNDO_LIMIT = 500;
/** A pause in typing longer than this starts a new undo step. */
const COALESCE_MS = 2000;
/** One visual row of `.note-text` (its line-height in globals.css). */
const ROW = 20;
/** Room kept between the caret and the edge of the scrolling panel body. */
const REVEAL_MARGIN = 8;

export const NoteEditor = memo(function NoteEditor({ initialLines, onChange, ref }: Props) {
  const [first] = useState(() => ensureLine(initialLines));
  const [initialValue] = useState(() => fieldValue(first));
  /** Render copy for the backdrop only; `model` is the truth. */
  const [lines, setLines] = useState(first);
  const model = useRef(first);
  /** Selection and model as they were at beforeinput — the "before" of a native edit. */
  const pre = useRef<{ start: number; end: number; lines: NoteLine[]; type: string } | null>(null);
  const composing = useRef(false);
  const compositionStartLines = useRef<NoteLine[] | null>(null);
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const lastEdit = useRef<{ group: "insert" | "delete" | "compose"; caret: number; time: number } | null>(null);
  /** Stops one ⌘Z from also being taken as the historyUndo it might arrive as. */
  const keyUndo = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const shellRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      focusEnd() {
        const field = fieldRef.current;
        if (!field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
        // The end of the note is its bottom line, so the bottom of the panel body
        // shows it — nothing to measure, and no dependence on pop-in's scale.
        const body = field.closest<HTMLElement>("[data-modal-body]");
        if (body) body.scrollTop = body.scrollHeight;
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const shell = shellRef.current!;
    const backdrop = backdropRef.current!;
    const field = fieldRef.current!;
    let live = true;
    /** Where the selection was when the latest key went down, for the keyup reveal. */
    let keyDownSelection: [number, number] | null = null;

    const snap = (): Snap => ({ lines: model.current, start: field.selectionStart, end: field.selectionEnd });

    const selection = () => {
      const a = field.selectionStart;
      const b = field.selectionEnd;
      return { a, b, from: caretAt(model.current, a), to: caretAt(model.current, b) };
    };

    /** Viewport top and bottom of the caret's row, measured on the backdrop's text. */
    function caretRow(position: number): { top: number; bottom: number } | null {
      const caret = caretAt(model.current, position);
      const el = backdrop.children[caret.index];
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const node = el.lastChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return { top: box.top, bottom: box.top + ROW };
      const text = node as Text;
      const range = document.createRange();
      let rect: DOMRect | undefined;
      if (caret.offset < text.length) {
        range.setStart(text, caret.offset);
        range.setEnd(text, caret.offset + 1);
        rect = range.getClientRects()[0];
      } else {
        // After the last character: its rect, on the last row it wraps to.
        range.setStart(text, caret.offset - 1);
        range.setEnd(text, caret.offset);
        const rects = range.getClientRects();
        rect = rects[rects.length - 1];
      }
      if (!rect) return { top: box.top, bottom: box.top + ROW };
      // Glyph rects are shorter than the row, so snap to the row grid the line is laid on.
      const row = Math.max(0, Math.round((rect.top + rect.height / 2 - box.top - ROW / 2) / ROW));
      const top = box.top + row * ROW;
      return { top, bottom: top + ROW };
    }

    /**
     * Scroll the panel body by the least that shows the caret. The field never
     * scrolls itself — it is as tall as its text — so the browser's own reveal
     * has to reach the panel, and it does not always: native-visible measured
     * the caret hidden on 3 of 34 keys without this.
     */
    function revealCaret() {
      if (document.activeElement !== field) return;
      const scroller = field.closest<HTMLElement>("[data-modal-body]");
      if (!scroller) return;
      const caret = caretRow(field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd);
      if (!caret) return;
      const view = scroller.getBoundingClientRect();
      if (caret.bottom > view.bottom - REVEAL_MARGIN) {
        scroller.scrollTop += Math.ceil(caret.bottom - (view.bottom - REVEAL_MARGIN));
      } else if (caret.top < view.top + REVEAL_MARGIN) {
        scroller.scrollTop -= Math.ceil(view.top + REVEAL_MARGIN - caret.top);
      }
    }

    /** Put a model on screen. The field is only written when its text must change. */
    function commit(next: NoteLine[], caret: Caret | null, { reveal = true }: { reveal?: boolean } = {}) {
      model.current = next;
      const value = fieldValue(next);
      if (field.value !== value) field.value = value;
      if (caret) {
        const at = positionOf(next, caret);
        field.setSelectionRange(at, at);
      }
      // Synchronously, so the backdrop changes in the same frame as the field's
      // text; a frame late, the caret sits over the old glyphs.
      flushSync(() => setLines(next));
      // A row that wrapped before the backdrop grew can scroll the field inside
      // itself, which slides its text off the backdrop's.
      field.scrollTop = 0;
      field.scrollLeft = 0;
      if (reveal) revealCaret();
      onChangeRef.current(next);
    }

    function pushUndo(state: Snap) {
      undoStack.current.push(state);
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
      redoStack.current.length = 0;
    }

    /** An edit the editor made itself: always its own undo step. */
    function structural(before: Snap, next: NoteLine[], caret: Caret | null, options?: { reveal?: boolean }) {
      pushUndo(before);
      commit(next, caret, options);
      lastEdit.current = null;
    }

    function restore(state: Snap) {
      commit(state.lines, null, { reveal: false });
      field.setSelectionRange(state.start, state.end);
      revealCaret();
      lastEdit.current = null;
    }

    function undoStep() {
      const state = undoStack.current.pop();
      if (!state) return;
      redoStack.current.push(snap());
      restore(state);
    }

    function redoStep() {
      const state = redoStack.current.pop();
      if (!state) return;
      undoStack.current.push(snap());
      restore(state);
    }

    /** Enter: a selection goes first, then the line splits at the caret. */
    function enter() {
      const before = snap();
      const { a, b, from, to } = selection();
      let current = model.current;
      let at = from;
      if (a !== b) {
        const removed = deleteRange(current, from, to);
        current = removed.lines;
        at = removed.caret;
      }
      const split = splitLine(current, at.index, at.offset);
      structural(before, split.lines, split.caret);
    }

    /**
     * Backspace — plain, word or line — with the caret at the very start of a
     * line: unmake the box, or join onto the line above. False when it is not
     * that case, and the browser deletes as usual.
     */
    function backspaceAtLineStart(): boolean {
      if (field.selectionStart !== field.selectionEnd) return false;
      const current = model.current;
      const caret = caretAt(current, field.selectionStart);
      if (caret.offset !== 0 || (caret.index === 0 && current[0].kind !== "check")) return false;
      const edit = backspaceAtStart(current, caret.index);
      structural(snap(), edit.lines, edit.caret);
      return true;
    }

    /** Delete forward at the very end of a line that has one below it. */
    function deleteAtLineEnd(): boolean {
      if (field.selectionStart !== field.selectionEnd) return false;
      const current = model.current;
      const caret = caretAt(current, field.selectionStart);
      if (caret.index === current.length - 1 || caret.offset !== current[caret.index].text.length) return false;
      const edit = deleteForwardAtEnd(current, caret.index);
      structural(snap(), edit.lines, edit.caret);
      return true;
    }

    function onKeyDown(e: KeyboardEvent) {
      keyDownSelection = [field.selectionStart, field.selectionEnd];
      // Keys during composition belong to the IME: Enter commits it, Backspace edits the marked text.
      if (composing.current || e.isComposing || e.keyCode === 229) return;
      const command = e.metaKey && !e.ctrlKey && !e.altKey;
      if (command && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        keyUndo.current = true;
        queueMicrotask(() => {
          keyUndo.current = false;
        });
        if (e.shiftKey) redoStep();
        else undoStep();
        return;
      }
      if (command && e.key === "Enter") {
        e.preventDefault();
        const { a, b, from, to } = selection();
        // A selection ending at column 0 (a triple-click, ⇧↓) does not take that
        // line — the same rule deleteRange and serializeRange follow.
        const last = a !== b && to.offset === 0 && to.index > from.index ? to.index - 1 : to.index;
        const next = toggleLines(model.current, from.index, last);
        // No boxes on those lines: nothing changed, so no empty undo step either.
        if (next !== model.current) structural(snap(), next, null, { reveal: false });
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // The line model, not the textarea, decides what a new line means.
        e.preventDefault();
        enter();
        return;
      }
      if (e.key === "Backspace" && !e.ctrlKey) {
        if (backspaceAtLineStart()) e.preventDefault();
        return;
      }
      const ctrlD = e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "d" || e.key === "D");
      if ((e.key === "Delete" && !e.ctrlKey) || ctrlD) {
        if (deleteAtLineEnd()) e.preventDefault();
      }
      // Arrows, Tab and everything else are the browser's.
    }

    /**
     * Reveal after a key only when that key moved the selection — so ⌘C, or
     * pressing ⌘ on its own, does not yank a panel you scrolled away back to the
     * caret. A keyup with no keydown here (Tab in from the title) always reveals.
     */
    function onKeyUp(e: KeyboardEvent) {
      if (composing.current || e.isComposing) return;
      const moved =
        !keyDownSelection ||
        keyDownSelection[0] !== field.selectionStart ||
        keyDownSelection[1] !== field.selectionEnd;
      if (moved) revealCaret();
    }

    function onBeforeInput(e: InputEvent) {
      const type = e.inputType;
      if (type === "historyUndo" || type === "historyRedo") {
        // The Edit menu, or execCommand: the same stack as ⌘Z, and never twice for one ⌘Z.
        e.preventDefault();
        if (!keyUndo.current) (type === "historyUndo" ? undoStep : redoStep)();
        return;
      }
      if (!composing.current && !e.isComposing) {
        // Nothing is ever cancelled during IME; these are dictation, Ctrl+O, Ctrl+H, Ctrl+K and friends.
        if (type === "insertParagraph" || type === "insertLineBreak") {
          e.preventDefault();
          enter();
          return;
        }
        if (/^delete.*Backward$/.test(type) && backspaceAtLineStart()) {
          e.preventDefault();
          return;
        }
        if (/^delete.*Forward$/.test(type) && deleteAtLineEnd()) {
          e.preventDefault();
          return;
        }
      }
      pre.current = { start: field.selectionStart, end: field.selectionEnd, lines: model.current, type };
    }

    function onInput(e: Event) {
      const input = e as InputEvent;
      const value = field.value;
      const current = model.current;
      const previous = fieldValue(current);
      if (value === previous) {
        pre.current = null;
        return;
      }
      const type = input.inputType ?? "";
      // Only trust the captured selection if nothing re-modelled the note since.
      const hint = pre.current && pre.current.lines === current ? pre.current : null;
      const d = diffEdit(previous, value, hint?.start ?? null, hint?.end ?? null, /Backward$/.test(type));
      const from = caretAt(current, d.from);
      const to = caretAt(current, d.to);
      const before: Snap = { lines: current, start: hint ? hint.start : d.from, end: hint ? hint.end : d.to };
      const composingNow = composing.current || input.isComposing;
      const raw = replaceRangeRaw(current, from, to, d.text);
      // While composing the model only mirrors the field: rewriting it would break the composition.
      const smart = composingNow ? raw : replaceRange(current, from, to, d.text);
      pre.current = null;

      // A run of typing (or of deleting) at a contiguous caret is one undo step.
      const group = type.startsWith("delete") ? "delete" : composingNow ? "compose" : "insert";
      const now = performance.now();
      const last = lastEdit.current;
      const coalesce =
        !!last &&
        last.group === group &&
        before.start === before.end &&
        last.caret === before.start &&
        now - last.time < COALESCE_MS &&
        !d.text.includes("\n");
      if (coalesce) redoStack.current.length = 0;
      else pushUndo(before);

      if (fieldValue(smart.lines) === value) {
        // The usual case: the rules left the text alone, so the field is never touched.
        commit(smart.lines, null);
        lastEdit.current = { group, caret: field.selectionStart, time: now };
      } else {
        // A rule rewrote the text ("- " eaten). What was literally typed becomes its
        // own undo step first, so undo gives the characters back before the box.
        model.current = raw.lines;
        pushUndo({ lines: raw.lines, start: field.selectionStart, end: field.selectionEnd });
        commit(smart.lines, smart.caret);
        lastEdit.current = null;
      }
    }

    function onCompositionStart() {
      composing.current = true;
      compositionStartLines.current = model.current;
    }

    function onCompositionEnd() {
      composing.current = false;
      // WebKit delivers the committing input before compositionend, so the "- "
      // rule that mirroring skipped runs a task later, once that input has landed.
      setTimeout(() => {
        if (!live || composing.current) return;
        const current = model.current;
        const caret = caretAt(current, field.selectionStart);
        const line = current[caret.index];
        if (line.kind !== "text") return;
        // setText converts only when an edit introduced the marker, so hand it
        // this line as it was when composition began: a line that already
        // started "- " then stays text, exactly as it would for typed keys.
        const was = compositionStartLines.current?.[caret.index];
        const base: NoteLine = was && was.kind === "text" ? was : { kind: "text", text: "" };
        const edit = setText(
          current.map((l, i) => (i === caret.index ? base : l)),
          caret.index,
          line.text,
          caret.offset,
        );
        if (edit.lines[caret.index].kind === "check") structural(snap(), edit.lines, edit.caret);
      }, 0);
    }

    /** The clipboard text for a selection spanning lines; null leaves copying to the browser. */
    function clipboardText(): string | null {
      const { a, b, from, to } = selection();
      if (a === b || from.index === to.index) return null;
      return serializeRange(model.current, from, to);
    }

    function onCopy(e: ClipboardEvent) {
      const text = clipboardText();
      if (text === null || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
    }

    function onCut(e: ClipboardEvent) {
      const text = clipboardText();
      // Within one line the cut is native, and the input diff picks it up.
      if (text === null || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      const { from, to } = selection();
      const edit = deleteRange(model.current, from, to);
      structural(snap(), edit.lines, edit.caret);
    }

    function onPaste(e: ClipboardEvent) {
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const { from, to } = selection();
      const edit = replaceRange(model.current, from, to, text, { paste: true });
      structural(snap(), edit.lines, edit.caret);
    }

    /** Drag-moving text inside the note is switched off; an outside drop is still native text. */
    function onDragStart(e: DragEvent) {
      e.preventDefault();
    }

    /** The field is as tall as its text, so any scroll inside it is a drift away from the backdrop. */
    function onFieldScroll() {
      if (field.scrollTop !== 0 || field.scrollLeft !== 0) {
        field.scrollTop = 0;
        field.scrollLeft = 0;
      }
    }

    function onShellMouseDown(e: MouseEvent) {
      const target = e.target as Element;
      if (target.closest(".note-box")) {
        // A tick must not take focus, the caret, the selection or the scroll position with it.
        e.preventDefault();
        return;
      }
      if (target === field || e.button !== 0) return;
      // The padding and the gutter. Beside a line, the caret goes to that line's
      // start; anywhere else, the end of the note, the way clicking under the
      // last line of a document does. Below the text is the field itself.
      e.preventDefault();
      field.focus({ preventScroll: true });
      let at = field.value.length;
      if (e.clientX < field.getBoundingClientRect().left) {
        const rows = backdrop.children;
        for (let i = 0; i < rows.length; i++) {
          const band = rows[i].getBoundingClientRect();
          if (e.clientY >= band.top && e.clientY < band.bottom) {
            at = positionOf(model.current, { index: i, offset: 0 });
            break;
          }
        }
      }
      field.setSelectionRange(at, at);
      revealCaret();
    }

    function onShellClick(e: MouseEvent) {
      const box = (e.target as Element).closest<HTMLElement>(".note-box");
      if (!box) return;
      structural(snap(), toggle(model.current, Number(box.dataset.index)), null, { reveal: false });
    }

    const listen = <E extends Event>(target: EventTarget, type: string, handler: (e: E) => void) => {
      target.addEventListener(type, handler as EventListener);
      return () => target.removeEventListener(type, handler as EventListener);
    };
    const detach = [
      listen(field, "keydown", onKeyDown),
      listen(field, "keyup", onKeyUp),
      listen(field, "beforeinput", onBeforeInput),
      listen(field, "input", onInput),
      listen(field, "compositionstart", onCompositionStart),
      listen(field, "compositionend", onCompositionEnd),
      listen(field, "copy", onCopy),
      listen(field, "cut", onCut),
      listen(field, "paste", onPaste),
      listen(field, "dragstart", onDragStart),
      listen(field, "scroll", onFieldScroll),
      listen(shell, "mousedown", onShellMouseDown),
      listen(shell, "click", onShellClick),
    ];
    return () => {
      live = false;
      for (const off of detach) off();
    };
  }, []);

  const empty = lines.length === 1 && lines[0].kind === "text" && lines[0].text === "";

  return (
    <div
      ref={shellRef}
      className="cursor-text rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3.5 py-3
        transition-colors focus-within:border-[#3d3d3d]"
    >
      <div className="note-stack">
        <div ref={backdropRef} className="note-backdrop note-text" aria-hidden="true">
          {lines.map((line, i) => (
            <Line key={i} index={i} line={line} />
          ))}
        </div>
        <textarea
          ref={fieldRef}
          className="note-field note-text"
          rows={1}
          defaultValue={initialValue}
          aria-label="Notes"
          placeholder={empty ? "Notes…" : ""}
        />
      </div>
    </div>
  );
});

export default NoteEditor;

/**
 * One backdrop line. It only draws — no state, no effects, nothing measures it —
 * which is why `key={index}` is safe. The box sits inside the line and CSS hangs
 * it into the gutter beside the first row, so a wrapped line needs no measuring.
 */
const Line = memo(
  function Line({ index, line }: { index: number; line: NoteLine }) {
    const done = line.kind === "check" && line.done;
    return (
      <div className={done ? "note-ln done" : "note-ln"}>
        {line.kind === "check" && (
          <button type="button" tabIndex={-1} className="note-box" data-index={index} aria-hidden="true" />
        )}
        {line.text === "" ? <br /> : line.text}
      </div>
    );
  },
  (a, b) =>
    a.index === b.index &&
    a.line.kind === b.line.kind &&
    a.line.text === b.line.text &&
    (a.line.kind === "check" && a.line.done) === (b.line.kind === "check" && b.line.done),
);
