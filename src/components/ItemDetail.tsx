"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Modal from "./Modal";
import NoteEditor, { type NoteEditorHandle } from "./NoteEditor";
import {
  checkCount,
  ensureLine,
  formatNotes,
  noteSummary,
  parseNotes,
  type NoteLine,
  type NoteSummary,
} from "@/lib/checklist";
import { titleCommit } from "@/lib/title";
import { formatMinutes } from "@/lib/time";
import type { BoardItem } from "@/lib/board";
import type { CalendarRecord } from "@/lib/types";

/**
 * The panel a double-click opens on a board row or a goal task: whatever you
 * want to write down about that item.
 *
 * The notes are one block of text. A line beginning "- " becomes a tick-box as
 * you type it, Enter carries the list on and Enter on an empty box ends it —
 * the rules live in lib/checklist. The editor is NoteEditor: one textarea with
 * transparent glyphs over a backdrop that draws the same lines, so a selection
 * can run from one line into the next like in any text box. The boxes and the
 * faint, struck-through ticked lines are CSS on the backdrop, and undo belongs
 * to the editor, because Habits.app's Edit menu never reaches the web view.
 * This file only loads the note, saves it and frames it.
 *
 * It saves as you type (debounced) and again on close, so there is no Save
 * button to forget — this is a notepad, not a form like EventDialog. A save
 * patches the row's marker through `onNoteChange` and nothing more. Refetching
 * the page on every pause in typing re-rendered everything, and the "Saving…"
 * footer coming and going made the centred dialog jump 20px each time. The one
 * refetch happens on close, and only if something was written.
 *
 * The title is editable here for to-dos, goal tasks and local events, through
 * `subject.rename` — this file never names an API. feed events keep a
 * read-only title and time: the feed is read-only. The note is keyed by the
 * item, so neither a rename nor a note detaches anything.
 */

const SAVE_DEBOUNCE_MS = 600;

export type RenameResult = { ok: true } | { ok: false; error: string };
type Rename = (title: string) => Promise<RenameResult>;

/**
 * What the panel is open on. The board passes its row; the Dashboard passes a
 * goal task, which has no occurrence, no calendar and no time — so it says
 * what to write above the editor rather than being read out of a BoardItem.
 * `rename` is there only when the title may change; without it the title is
 * read-only.
 */
export type NoteSubject =
  | { kind: "board"; item: BoardItem; calendar?: CalendarRecord; rename?: Rename }
  | { kind: "plain"; noteKey: string; title: string; meta?: string[]; rename?: Rename };

/** The caller picks the API; this only speaks PATCH and reads `{error}`. */
export async function patchTitle(url: string, body: Record<string, unknown>): Promise<RenameResult> {
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true, // lets an unmount-time rename outlive the panel
    });
    if (res.ok) return { ok: true };
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: payload?.error ?? "Could not rename that" };
  } catch {
    return { ok: false, error: "Could not reach the server" };
  }
}

export default function ItemDetail({
  subject,
  onClose,
  onSaved,
  onNoteChange,
}: {
  subject: NoteSubject;
  onClose: () => void;
  /**
   * Refetch. Called after a rename, and once on close if a note was written —
   * never per save, which is what made the panel lag.
   */
  onSaved: () => void;
  /** After every note save: the row's marker, so it keeps up without a refetch. */
  onNoteChange?: (summary: NoteSummary) => void;
}) {
  const item = subject.kind === "board" ? subject.item : null;
  const calendar = subject.kind === "board" ? subject.calendar : undefined;
  const noteKey = item ? item.key : subject.kind === "plain" ? subject.noteKey : "";
  /** The note as loaded; null until then. The editor owns every change after. */
  const [initialLines, setInitialLines] = useState<NoteLine[] | null>(null);
  const [counts, setCounts] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const editorRef = useRef<NoteEditorHandle>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What is on the server, so close does not re-save an untouched note. */
  const savedBody = useRef("");
  /** The newest text, for a close or an unmount to flush without a stale copy. */
  const pending = useRef("");
  /** Something was saved that the parent has not refetched since. */
  const wrote = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onNoteChangeRef = useRef(onNoteChange);
  onNoteChangeRef.current = onNoteChange;
  const keyRef = useRef(noteKey);
  keyRef.current = noteKey;

  const title = item
    ? item.kind === "event"
      ? item.occurrence.title
      : item.task.title
    : subject.kind === "plain"
      ? subject.title
      : "";
  const startMin = item ? (item.kind === "event" ? item.occurrence.startMin : item.task.startMin) : null;

  // ---- The title ----------------------------------------------------------
  const renameRef = useRef(subject.rename);
  renameRef.current = subject.rename;
  const [titleDraft, setTitleDraftState] = useState(title);
  const titleDraftRef = useRef(title);
  const setTitleDraft = useCallback((value: string) => {
    titleDraftRef.current = value;
    setTitleDraftState(value);
  }, []);
  /** What the server will hold once queued renames land — the "unchanged" baseline. */
  const queuedTitle = useRef(title);
  /** Last title the server confirmed — what a failed rename falls back to. */
  const serverTitle = useRef(title);
  const titleFocused = useRef(false);
  const renamesInFlight = useRef(0);
  const lastRename = useRef<Promise<boolean>>(Promise.resolve(true));
  const [renaming, setRenaming] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  // Take a new title from the parent (a refetch, or a rename made elsewhere),
  // but never mid-rename: a refetch that started before the PATCH would pull
  // the old title back into the field, and our own refetch settles it anyway.
  useEffect(() => {
    if (renamesInFlight.current > 0) return;
    const wasClean = titleDraftRef.current === queuedTitle.current;
    serverTitle.current = title;
    queuedTitle.current = title;
    if (!titleFocused.current || wasClean) setTitleDraft(title);
  }, [title, setTitleDraft]);

  // ---- The note -----------------------------------------------------------
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/notes?key=${encodeURIComponent(noteKey)}`, {
          cache: "no-store",
        });
        if (!live) return;
        if (!res.ok) {
          // An empty editor and a note that failed to load look identical, and
          // typing into the second would overwrite what is really stored. Say
          // so instead, and leave nothing to save.
          setError("Could not load this note");
          return;
        }
        const body = ((await res.json()) as { body: string }).body;
        if (!live) return;
        savedBody.current = body;
        pending.current = body;
        const parsed = ensureLine(parseNotes(body));
        setCounts(checkCount(parsed));
        setInitialLines(parsed);
      } catch {
        if (live) setError("Could not load this note");
      }
    })();
    return () => {
      live = false;
    };
  }, [noteKey]);

  // Land in the note ready to type, at the end of what is already there — but
  // not if the title was clicked into while the note loaded.
  useEffect(() => {
    if (initialLines && !titleFocused.current) editorRef.current?.focusEnd();
  }, [initialLines]);

  const save = useCallback(
    async (body: string): Promise<boolean> => {
      if (body === savedBody.current) return true;
      // No "saving" state: rendering it twice a save was part of the lag, and a
      // local write takes about 10ms.
      try {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: noteKey, body }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? "Could not save that note");
          return false;
        }
        savedBody.current = body;
        wrote.current = true;
        setError(null);
        onNoteChangeRef.current?.(noteSummary(parseNotes(body)));
        return true;
      } catch {
        setError("Could not reach the server");
        return false;
      }
    },
    [noteKey],
  );

  /** Every change the editor makes: the footer's count, then a debounced write. */
  const onEditorChange = useCallback(
    (next: NoteLine[]) => {
      const body = formatNotes(next);
      // A tick undone, a caret move that re-committed: nothing to write.
      if (body === pending.current) return;
      pending.current = body;
      const c = checkCount(next);
      setCounts((prev) => (prev.done === c.done && prev.total === c.total ? prev : c));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(body), SAVE_DEBOUNCE_MS);
    },
    [save],
  );

  /**
   * Save the title. It touches only refs, so it is stable. Renames run one after
   * another on a promise chain, so the last title typed wins, and a draft is
   * compared with `queuedTitle` so the Close button's blur and its close send one
   * PATCH between them, not two.
   *
   * `refetch` is false only from close, which refetches once for the note and
   * the title together.
   */
  const commitTitle = useCallback(
    (refetch: boolean): Promise<boolean> => {
      const send = renameRef.current;
      if (!send) return Promise.resolve(true);
      const idle = () => (renamesInFlight.current > 0 ? lastRename.current : Promise.resolve(true));
      const decision = titleCommit(titleDraftRef.current, queuedTitle.current);
      if (decision.action !== "save") {
        // Revert an empty title; tidy "  foo " back to "foo".
        if (titleDraftRef.current !== queuedTitle.current) setTitleDraft(queuedTitle.current);
        // Wait on a rename still in flight, else there is nothing to flush. Not
        // lastRename itself: after a failed rename that is a settled false, and
        // reverting then pressing Escape again would never close the panel.
        return idle();
      }
      const next = decision.title;
      queuedTitle.current = next;
      setTitleDraft(next);
      renamesInFlight.current += 1;
      setRenaming(true);
      const run = lastRename.current.then(async () => {
        let result: RenameResult;
        try {
          result = await send(next);
        } catch {
          result = { ok: false, error: "Could not reach the server" };
        }
        renamesInFlight.current -= 1;
        if (renamesInFlight.current === 0) setRenaming(false);
        if (result.ok) {
          serverTitle.current = next;
          setTitleError(null);
          if (refetch) {
            // The refetch reads the row's note marker too, so it settles any
            // note saved before it — close has nothing left to refetch for.
            wrote.current = false;
            onSavedRef.current();
          } else {
            wrote.current = true;
          }
          return true;
        }
        // The draft stays as typed, so it still reads as edited.
        if (queuedTitle.current === next) queuedTitle.current = serverTitle.current;
        setTitleError(result.error);
        return false;
      });
      lastRename.current = run;
      return run;
    },
    [setTitleDraft],
  );

  // Closing must not lose the last few keystrokes still inside the debounce, nor
  // a title typed and never blurred: a backdrop mousedown removes the panel with
  // no blur at all (measured). It must not close over the lines either — a new
  // identity on every keystroke would re-run Modal's Escape effect.
  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void Promise.all([save(pending.current), commitTitle(false)]).then(([notesOk, titleOk]) => {
      // A failed save or rename keeps the panel open with the error, rather
      // than dismissing it and taking the text with it.
      if (!notesOk || !titleOk) return;
      if (wrote.current) {
        wrote.current = false;
        onSavedRef.current();
      }
      onCloseRef.current();
    });
  }, [save, commitTitle]);

  useEffect(() => {
    return () => {
      if (!timer.current) return;
      // Unmounted mid-debounce — the board refetched this row away, or the page
      // navigated. keepalive lets the write outlive the component.
      clearTimeout(timer.current);
      const body = pending.current;
      if (body === savedBody.current) return;
      void fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyRef.current, body }),
        keepalive: true,
      })
        .then((res) => {
          if (res.ok) onNoteChangeRef.current?.(noteSummary(parseNotes(body)));
        })
        .catch(() => {
          /* nothing left to tell: the panel has gone */
        });
    };
  }, []);

  // Separate from the note's flush above, which returns early when no debounce
  // is pending and would skip a rename typed and never blurred.
  useEffect(
    () => () => {
      const send = renameRef.current;
      if (!send) return;
      const decision = titleCommit(titleDraftRef.current, queuedTitle.current);
      if (decision.action === "save") {
        void send(decision.title).then(
          (result) => result.ok && onSavedRef.current(),
          () => {},
        );
      }
    },
    [],
  );

  /** Enter in the title: on to the end of the notes, where opening the panel lands. */
  const focusNotesEnd = useCallback((field: HTMLTextAreaElement) => {
    // No notes field (still loading, or it failed to): just leave the title,
    // and its blur saves.
    if (!editorRef.current) return field.blur();
    editorRef.current.focusEnd();
  }, []);

  // The day is already obvious from the column the row was opened in, so only
  // what the row does not already say goes here.
  const meta: React.ReactNode[] = [];
  if (startMin !== null) meta.push(formatMinutes(startMin));
  if (subject.kind === "plain") meta.push(...(subject.meta ?? []).filter(Boolean));
  if (item?.kind === "event") {
    meta.push(
      <>
        <span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: item.occurrence.habitColor ?? calendar?.color ?? "#6b6b6b" }}
        />
        {calendar?.name ?? "No calendar"}
      </>,
    );
    if (item.occurrence.origin === "ics") {
      meta.push(<span className="text-[var(--text-faint)]">from your calendar, notes stay here</span>);
    }
  }

  const problem = [error, titleError].filter(Boolean).join(" · ");

  return (
    <Modal
      title={title}
      onClose={close}
      wide
      placement="top"
      initialFocus="panel"
      heading={
        subject.rename ? (
          <TitleField
            value={titleDraft}
            onChange={setTitleDraft}
            onFocusChange={(focused) => {
              titleFocused.current = focused;
              if (!focused) void commitTitle(true);
            }}
            onEnter={focusNotesEnd}
            onEscape={() => {
              if (titleDraftRef.current === queuedTitle.current) return false;
              setTitleDraft(queuedTitle.current);
              setTitleError(null);
              return true;
            }}
          />
        ) : item?.kind === "event" && item.occurrence.origin === "ics" ? (
          // Same box as TitleField, so the heading lines up with Close the same way.
          <h2
            className="min-w-0 flex-1 break-words py-1 text-[14px] font-semibold leading-[21px]"
            title="From your calendar — rename it there"
          >
            {title}
          </h2>
        ) : undefined
      }
      // Always there, and always one height. A footer that came and went with
      // "Saving…" moved the dialog on every save; notes no longer say it at all,
      // only a rename does, inside the same fixed slot.
      footer={
        <span className="flex h-4 min-w-0 items-center text-[11px] leading-4 text-[var(--text-faint)]">
          {problem ? (
            <span className="truncate text-[12px] text-[#e05a5a]" title={problem}>
              {problem}
            </span>
          ) : (
            <>
              {counts.total > 0 && (
                <span className="tabular-nums">
                  {counts.done}/{counts.total} ticked
                </span>
              )}
              {renaming && <span className={counts.total > 0 ? "ml-2" : ""}>Saving…</span>}
            </>
          )}
        </span>
      }
    >
      {meta.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--text-muted)]">
          {meta.map((part, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">·</span>}
              {part}
            </span>
          ))}
        </div>
      )}

      {item?.kind === "event" && item.occurrence.notes ? (
        <p className="mb-3 whitespace-pre-wrap rounded-lg bg-[var(--bg)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {item.occurrence.notes}
        </p>
      ) : null}

      {initialLines === null ? (
        <p className="text-[12px] text-[var(--text-faint)]">{error ? "" : "Loading…"}</p>
      ) : (
        <NoteEditor key={noteKey} ref={editorRef} initialLines={initialLines} onChange={onEditorChange} />
      )}
    </Modal>
  );
}

/**
 * The panel's title as a heading you can type into. A textarea, not an input,
 * because a sentence lifted from meeting minutes has to wrap; a line break
 * typed or pasted becomes a space the moment it arrives.
 *
 * Enter moves on to the notes and blur saves. Escape reverts an edited title
 * and keeps the panel open (by preventDefault, which Modal checks); on an
 * unedited title it does nothing, so Escape still closes the panel from here.
 */
function TitleField({
  value,
  onChange,
  onFocusChange,
  onEnter,
  onEscape,
}: {
  value: string;
  onChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
  onEnter: (field: HTMLTextAreaElement) => void;
  /** True when Escape was used (an edit reverted) — the panel then stays open. */
  onEscape: () => boolean;
}) {
  const el = useRef<HTMLTextAreaElement>(null);
  // It lives in the header, outside the scrolling body, so the height reset
  // before measuring cannot clamp the note's scroll position.
  const grow = useCallback(() => {
    const node = el.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, []);
  useLayoutEffect(grow, [value, grow]);
  useEffect(() => {
    window.addEventListener("resize", grow);
    return () => window.removeEventListener("resize", grow);
  }, [grow]);

  return (
    <h2 className="min-w-0 flex-1">
      <textarea
        ref={el}
        rows={1}
        value={value}
        aria-label="Title"
        // Modal's focus-on-open skips it: opening a panel never drops you into renaming.
        data-no-autofocus
        onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter(e.currentTarget);
          } else if (e.key === "Escape" && onEscape()) {
            // Not stopPropagation: Modal listens on document, the same node as
            // React's root, so only defaultPrevented reaches it.
            e.preventDefault();
          }
        }}
        // py-1 with a 21px line puts the first line's centre level with Close's.
        className="item-title -mx-1 block w-[calc(100%+0.5rem)] resize-none overflow-hidden break-words
          rounded-md bg-transparent px-1 py-1 text-[14px] font-semibold leading-[21px] text-[var(--text)]
          transition-colors hover:bg-white/[0.04] focus:bg-[var(--bg)] focus:shadow-[inset_0_0_0_1px_#3d3d3d]"
      />
    </h2>
  );
}
