"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import ItemDetail, { patchTitle, type NoteSubject } from "./ItemDetail";
import { ACTION_ID_PREFIX, isBacklogId, useDragArea } from "./DragHub";
import type { NoteSummary } from "@/lib/checklist";
import {
  addDays,
  clockFieldsOf,
  commitFor,
  dayNumber,
  formatMinutes,
  readClockFields,
  type Meridiem,
  type ReadTime,
} from "@/lib/time";
import { isPaused, type PauseRecord } from "@/lib/away";
import type { BoardItem } from "@/lib/board";
import type { CalendarRecord, Occurrence } from "@/lib/types";

type Props = {
  days: string[];
  today: string;
  items: Record<string, BoardItem[]>;
  calendarsById: Map<string, CalendarRecord>;
  onToggleEvent: (occurrence: Occurrence, completed: boolean) => void;
  onChanged: () => void | Promise<void>;
  /** A note was saved in the details panel: patch that row's marker, no refetch. */
  onNoteChange?: (key: string, summary: NoteSummary) => void;
  /** Time away: paused days get a small mark, and the composer knows the trigger. */
  pauses: PauseRecord[];
  /** Raised while a drag is in flight, so a wake refetch waits its turn. */
  onDragStateChange?: (dragging: boolean) => void;
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Mirrors BOARD_ROW_DAYS in lib/view — kept local so the client bundle does
 *  not pull in the server-only module graph behind it. */
const ROW_DAYS = 7;

const ROW_CAPTIONS = ["Last 7 days", "From today", "Next week"];

/** How long a single click waits to see whether a second one is coming. */
const DOUBLE_CLICK_MS = 220;

function weekdayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function titleOf(item: BoardItem): string {
  return item.kind === "event" ? item.occurrence.title : item.task.title;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

function startMinOf(item: BoardItem): number | null {
  return item.kind === "event"
    ? item.occurrence.allDay
      ? null
      : item.occurrence.startMin
    : item.task.startMin;
}

/**
 * The dashboard's to-do board: three rolling seven-day rows anchored on today.
 *
 * A day is one list mixing calendar events and free-text to-dos, ordered by
 * hand rather than by the clock — anything can be dragged anywhere, and any row
 * can be given a time. Reordering inside a day never touches the underlying
 * event; moving a feed event to another day, or retiming it, detaches a
 * local copy, since there is no write path back to the calendar.
 */
export default function TodoBoard({
  days,
  today,
  items,
  calendarsById,
  onToggleEvent,
  onChanged,
  onNoteChange,
  pauses,
  onDragStateChange,
}: Props) {
  const rows = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < days.length; i += ROW_DAYS) out.push(days.slice(i, i + ROW_DAYS));
    return out;
  }, [days]);

  const itemsByKey = useMemo(() => {
    const map = new Map<string, BoardItem>();
    for (const list of Object.values(items)) for (const item of list) map.set(item.key, item);
    return map;
  }, [items]);

  // Key order per column, held locally so a drag can reorder optimistically.
  const serverColumns = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const ymd of days) map[ymd] = (items[ymd] ?? []).map((i) => i.key);
    return map;
  }, [days, items]);

  const [columns, setColumns] = useState(serverColumns);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const dragOrigin = useRef<string | null>(null);
  /** The latest server order, kept current even while a drag holds it back. */
  const serverRef = useRef(serverColumns);
  /** True from pointer-down until the move has been saved. */
  const dragging = useRef(false);
  /** Keys whose move is still in flight; picking one up again would double it. */
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const [moveError, setMoveError] = useState<string | null>(null);
  /** The row whose details panel is open, if any. */
  const [detailKey, setDetailKey] = useState<string | null>(null);

  useEffect(() => {
    serverRef.current = serverColumns;
    // A refetch landing mid-drag would yank the row out from under the pointer:
    // the "+ task" composer commits on blur, so merely starting a drag can
    // trigger one. Hold it — the drop applies the server's order itself.
    if (dragging.current) return;
    setColumns(serverColumns);
  }, [serverColumns]);

  function columnContaining(id: string, source = columns): string | undefined {
    if (id in source) return id;
    return Object.keys(source).find((ymd) => source[ymd].includes(id));
  }

  function endDrag() {
    dragging.current = false;
    onDragStateChange?.(false);
  }

  /** Put the board back the way the server has it, dropping any drag preview. */
  function abandonDrag() {
    setColumns(serverRef.current);
    endDrag();
  }

  function onDragOver(event: DragOverEvent) {
    const active = String(event.active.id);
    const overId = event.over?.id;
    if (!overId) return;
    const over = String(overId);

    // Both columns are resolved against `prev`, not the render's snapshot:
    // several of these fire between renders, and reading a stale `from` used to
    // insert the key a second time into the column it had already reached.
    setColumns((prev) => {
      const from = columnContaining(active, prev);
      const to = columnContaining(over, prev);
      if (!from || !to || from === to) return prev;
      const target = prev[to] ?? [];
      const overIndex = target.indexOf(over);
      const insertAt = overIndex === -1 ? target.length : overIndex;
      return {
        ...prev,
        [from]: prev[from].filter((key) => key !== active),
        [to]: [...target.slice(0, insertAt), active, ...target.slice(insertAt)],
      };
    });
  }

  function onDragStart(event: DragStartEvent) {
    const key = String(event.active.id);
    setActiveKey(key);
    dragOrigin.current = columnContaining(key) ?? null;
    // Held for a backlog row too: one landing here refetches the board.
    dragging.current = true;
    onDragStateChange?.(true);
  }

  async function onDragEnd(event: DragEndEvent) {
    const active = String(event.active.id);
    const fromYmd = dragOrigin.current;
    setActiveKey(null);
    dragOrigin.current = null;

    if (active.startsWith(ACTION_ID_PREFIX)) return dropFromBacklog(event);

    // Carried over to "Need to action": the backlog makes the move, since only
    // it knows which of its rows the drop landed between. A to-do leaves the
    // board now, so it does not flash back into its day before the refetch;
    // an event cannot go, and the backlog says so.
    const overKey = event.over?.id ? String(event.over.id) : null;
    if (overKey && isBacklogId(overKey)) {
      if (!itemsByKey.get(active) || itemsByKey.get(active)?.kind !== "task") return abandonDrag();
      setColumns(() => {
        const next: Record<string, string[]> = {};
        for (const [ymd, keys] of Object.entries(serverRef.current)) {
          next[ymd] = keys.filter((key) => key !== active);
        }
        return next;
      });
      return endDrag();
    }

    // Dropped outside every column. onDragOver may already have previewed a
    // move to another day, and dnd-kit does not call onDragCancel for a drop,
    // so this is the only place that preview gets undone.
    const overId = event.over?.id;
    if (!overId || !fromYmd) return abandonDrag();

    const to = columnContaining(String(overId));
    if (!to) return abandonDrag();

    const target = columns[to] ?? [];
    const overIndex = target.indexOf(String(overId));
    const currentIndex = target.indexOf(active);

    // Settle the local order so the column does not flicker before the refetch.
    const settled = [...target];
    if (currentIndex !== -1) settled.splice(currentIndex, 1);
    settled.splice(overIndex === -1 ? settled.length : overIndex, 0, active);

    // Compare against the server's order, not the optimistic one: a drag that
    // wandered into another day and came back has already rewritten this
    // column, so comparing indices within it saw a move that was really a
    // return to the starting position.
    if (fromYmd === to && sameOrder(settled, serverRef.current[to] ?? [])) {
      return abandonDrag();
    }

    // Which items it landed between. Keys rather than an index, because this
    // tab's copy of the day can be a refetch behind and an ordinal computed
    // against it points somewhere else by the time the server reads it.
    const at = settled.indexOf(active);
    const beforeKey = at > 0 ? settled[at - 1] : null;
    const afterKey = at < settled.length - 1 ? settled[at + 1] : null;

    setColumns((prev) => ({ ...prev, [to]: settled }));
    setBusyKeys((keys) => [...keys, active]);
    try {
      const res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move",
          itemKey: active,
          fromYmd,
          toYmd: to,
          beforeKey,
          afterKey,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { key?: string; error?: string }
        | null;
      if (!res.ok) {
        setColumns(serverRef.current);
        setMoveError(body?.error ?? "Could not move that");
      } else if (body?.key && body.key !== active) {
        // Moving a feed event to another day detaches a local copy under a
        // new key. Adopt it now: dragging the dead key again would detach a
        // second copy.
        const settledKey = body.key;
        setColumns((prev) => ({
          ...prev,
          [to]: (prev[to] ?? []).map((key) => (key === active ? settledKey : key)),
        }));
      }
    } catch {
      setColumns(serverRef.current);
      setMoveError("Could not reach the server");
    } finally {
      setBusyKeys((keys) => keys.filter((key) => key !== active));
      endDrag();
      await onChanged();
    }
  }

  /**
   * A "Need to action" row dropped on a day becomes a to-do there, in the slot
   * it landed in — before the row under the pointer, or at the foot of the day
   * when it landed on the column itself. Dropped anywhere else (back in the
   * backlog, or nowhere), it is the backlog's business and the board lets go.
   */
  async function dropFromBacklog(event: DragEndEvent) {
    const overId = event.over?.id ? String(event.over.id) : null;
    const to = overId ? columnContaining(overId) : undefined;
    if (!overId || !to) return endDrag();

    const target = columns[to] ?? [];
    const overIndex = target.indexOf(overId);
    const at = overIndex === -1 ? target.length : overIndex;
    try {
      const res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fromBacklog",
          itemKey: String(event.active.id),
          toYmd: to,
          beforeKey: at > 0 ? target[at - 1] : null,
          afterKey: at < target.length ? target[at] : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMoveError(body?.error ?? "Could not move that onto the board");
      }
    } catch {
      setMoveError("Could not reach the server");
    } finally {
      endDrag();
      await onChanged();
    }
  }

  useDragArea("board", {
    onDragStart,
    onDragOver,
    onDragEnd,
    onDragCancel: () => {
      setActiveKey(null);
      dragOrigin.current = null;
      abandonDrag();
    },
    overlay: (id) => {
      const item = itemsByKey.get(id);
      if (!item) return null;
      return (
        <div
          className="flex items-start gap-1.5 rounded-md bg-[var(--card-hover)] px-1.5 py-1
            text-[12px] text-[var(--text)] shadow-xl"
        >
          <span className="mt-[3px] size-3 shrink-0 rounded-[3px] border border-[#6a6a6a]" />
          <span className="truncate">{titleOf(item)}</span>
        </div>
      );
    },
  });
  // Resolved from the live map, so the panel follows a refetch rather than
  // holding a copy that goes stale while it is open.
  const detailItem = detailKey ? itemsByKey.get(detailKey) : undefined;
  const detailCalendar =
    detailItem?.kind === "event" && detailItem.occurrence.calendarId
      ? calendarsById.get(detailItem.occurrence.calendarId)
      : undefined;

  // Memoised on the row itself, so a board render that did not replace it (a
  // drag, the composer, a marker patched on another row) hands the panel the
  // same subject. A refetch does replace it. The title is saved by
  // the API that owns it: a to-do through /api/tasks, a local event (a copy
  // detached from a feed included) through /api/events. A feed event gets no
  // rename — the feed is read-only, and that route refuses its key.
  const detailSubject = useMemo((): NoteSubject | null => {
    if (!detailItem) return null;
    return {
      kind: "board",
      item: detailItem,
      calendar: detailCalendar,
      rename:
        detailItem.kind === "task"
          ? (title) => patchTitle("/api/tasks", { id: detailItem.task.id, title })
          : detailItem.occurrence.origin === "local"
            ? (title) => patchTitle("/api/events", { key: detailItem.occurrence.key, title })
            : undefined,
    };
  }, [detailItem, detailCalendar]);

  const closeDetail = useCallback(() => setDetailKey(null), []);
  // Keyed by the row the panel was opened on, which the panel's last render
  // still holds if a save lands after it has gone.
  const detailNoteChange = useCallback(
    (summary: NoteSummary) => {
      if (detailKey) onNoteChange?.(detailKey, summary);
    },
    [detailKey, onNoteChange],
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-baseline gap-2 px-5 pb-3 pt-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            To do
          </h2>
          {moveError && (
            // A drag that silently reverts is what makes the board feel broken;
            // say what happened instead.
            <button
              type="button"
              onClick={() => setMoveError(null)}
              title="Dismiss"
              className="text-[11px] text-[#e05a5a]"
            >
              {moveError}
            </button>
          )}
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-8">
          {rows.map((row, i) => (
            <section key={row[0]} className={i > 0 ? "mt-1" : ""}>
              <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-[var(--bg)]/95 px-5 py-1.5 backdrop-blur">
                <span
                  className={`text-[11px] font-medium uppercase tracking-wide ${
                    i === 1 ? "text-[var(--text)]" : "text-[var(--text-faint)]"
                  }`}
                >
                  {ROW_CAPTIONS[i] ?? ""}
                </span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>

              <div className="grid grid-cols-7 gap-x-1 px-4">
                {row.map((ymd) => (
                  <DayColumn
                    key={ymd}
                    ymd={ymd}
                    isToday={ymd === today}
                    isPast={ymd < today}
                    away={isPaused(pauses, ymd)}
                    keys={columns[ymd] ?? []}
                    itemsByKey={itemsByKey}
                    calendarsById={calendarsById}
                    onToggleEvent={onToggleEvent}
                    onChanged={onChanged}
                    busyKeys={busyKeys}
                    onOpenDetail={setDetailKey}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {detailSubject && (
        <ItemDetail
          subject={detailSubject}
          onClose={closeDetail}
          onSaved={onChanged}
          onNoteChange={detailNoteChange}
        />
      )}

    </>
  );
}

function DayColumn({
  ymd,
  isToday,
  isPast,
  away,
  keys,
  itemsByKey,
  calendarsById,
  onToggleEvent,
  onChanged,
  busyKeys,
  onOpenDetail,
}: {
  ymd: string;
  isToday: boolean;
  isPast: boolean;
  away: boolean;
  keys: string[];
  itemsByKey: Map<string, BoardItem>;
  calendarsById: Map<string, CalendarRecord>;
  onToggleEvent: (occurrence: Occurrence, completed: boolean) => void;
  onChanged: () => void | Promise<void>;
  busyKeys: string[];
  onOpenDetail: (key: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // Enter submits and blur submits, and blur fires right after Enter. React
  // state clears a render too late for the second call to see it, so the ref
  // is the source of truth — cleared synchronously, it makes the follow-up
  // blur a no-op instead of adding the task twice.
  const pending = useRef("");
  const { setNodeRef, isOver } = useDroppable({ id: ymd });
  // "travel to tokyo" typed as a to-do: the composer changes its question to
  // "back on?" and, on Enter, also pauses habits from this day to that one.
  const [trip, setTrip] = useState<{ title: string; back: string } | null>(null);
  const tripInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (trip) tripInput.current?.focus();
  }, [trip]);

  function setValue(value: string) {
    pending.current = value;
    setDraft(value);
  }

  async function createTask(title: string): Promise<string | null> {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ymd, title }),
    });
    const body = (await res.json().catch(() => null)) as { task?: { id: string } } | null;
    return body?.task?.id ?? null;
  }

  async function addTask() {
    const title = pending.current.trim();
    if (!title) return;
    setValue("");
    if (TRAVEL.test(title)) {
      setTrip({ title, back: addDays(ymd, 7) });
      return;
    }
    await createTask(title);
    onChanged();
  }

  /**
   * Enter on the date: to-do plus pause, the pause owned by the to-do (delete
   * the to-do and the pause goes too). Escape: just the to-do.
   */
  async function finishTrip(withPause: boolean) {
    if (!trip) return;
    const { title, back } = trip;
    setTrip(null);
    const taskId = await createTask(title);
    if (withPause && /^\d{4}-\d{2}-\d{2}$/.test(back)) {
      await fetch("/api/pauses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromYmd: ymd,
          toYmd: back,
          label: title,
          originKey: taskId ? `task:${taskId}` : null,
        }),
      });
    }
    onChanged();
  }

  const items = keys.map((k) => itemsByKey.get(k)).filter((i): i is BoardItem => !!i);

  return (
    <div
      ref={setNodeRef}
      className={`flex min-w-0 flex-col rounded-lg px-1 pb-1 transition-colors ${
        isOver ? "bg-white/[0.05]" : ""
      } ${isPast ? "opacity-65" : ""}`}
    >
      <div className="flex items-baseline gap-1.5 px-1 pt-1.5">
        <span className="text-[11px] text-[var(--text-muted)]">{weekdayLabel(ymd)}</span>
        <span
          className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-medium tabular-nums
            ${isToday ? "bg-[var(--accent)] text-white" : "text-[var(--text)]"}`}
        >
          {dayNumber(ymd)}
        </span>
        {away && (
          <span
            className="text-[10px] text-[var(--text-faint)]"
            title="Away — habits are not required today"
            aria-label="Away"
          >
            ✈
          </span>
        )}
      </div>

      <div className="flex min-h-[72px] flex-col gap-px py-1">
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          {items.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              column={ymd}
              calendarsById={calendarsById}
              onToggleEvent={onToggleEvent}
              onChanged={onChanged}
              busy={busyKeys.includes(item.key)}
              onOpenDetail={() => onOpenDetail(item.key)}
            />
          ))}
        </SortableContext>

        {items.length === 0 && (
          <p className="px-1 py-1 text-[11px] text-[var(--text-faint)]">Nothing yet</p>
        )}
      </div>

      {trip ? (
        <div className="rounded-md bg-[var(--bg)] px-1 py-1">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <span aria-hidden="true">✈</span>
            <span>Back on?</span>
          </div>
          <input
            ref={tripInput}
            type="date"
            value={trip.back}
            min={ymd}
            onChange={(e) => setTrip({ ...trip, back: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") finishTrip(true);
              if (e.key === "Escape") finishTrip(false);
            }}
            aria-label="Return date"
            className="mt-0.5 w-full rounded bg-transparent text-[12px] text-[var(--text)] [color-scheme:dark]"
          />
          <div className="mt-0.5 text-[10px] leading-snug text-[var(--text-faint)]">
            ↵ pause habits until then · esc just the to-do
          </div>
        </div>
      ) : (
        <input
          value={draft}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTask();
            if (e.key === "Escape") setValue("");
          }}
          onBlur={addTask}
          placeholder="+ task"
          aria-label={`Add a task on ${ymd}`}
          className="w-full rounded-md bg-transparent px-1 py-1 text-[12px] text-[var(--text)]
            placeholder:text-[var(--text-faint)] focus:bg-[var(--bg)]"
        />
      )}
    </div>
  );
}

/** Words that turn a to-do into a trip: the composer then asks for the return date. */
const TRAVEL = /\b(travel(?:l?ing)?|holiday|vacation)\b/i;

function Tick({
  checked,
  color,
  label,
  onChange,
}: {
  checked: boolean;
  color: string;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-[3px] size-3 shrink-0 cursor-pointer appearance-none rounded-[3px] border
        border-[#6a6a6a] transition-colors checked:border-transparent"
      style={
        checked
          ? {
              backgroundColor: color,
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath fill='none' stroke='%23131313' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' d='M3 7.2l2.6 2.6L11 4.4'/%3E%3C/svg%3E\")",
              backgroundSize: "100%",
            }
          : undefined
      }
    />
  );
}

/**
 * The row's time: hour, minutes and am/pm — three fields of our own.
 *
 * It is deliberately the same shape as the `<input type="time">` it replaced,
 * because that is the way to enter a time. What it does not share is the
 * native control's one fatal habit: reporting an *empty value* for anything
 * incomplete. An entry still missing its am/pm read as "" and never reached
 * us at all, so adding a time did nothing, silently, with nothing to report.
 *
 * Owning the fields means every keystroke is ours. Blank minutes are o'clock,
 * an hour outside 1–12 is said out loud, and `readClockFields` is a pure
 * function the test suite can hold — none of which was reachable before.
 */
function TimeFields({
  startMin,
  label,
  onCommit,
  onCancel,
}: {
  startMin: number | null;
  label: string;
  onCommit: (read: ReadTime, explicit: boolean) => void;
  onCancel: () => void;
}) {
  const initial = clockFieldsOf(startMin);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [meridiem, setMeridiem] = useState<Meridiem>(initial.meridiem);
  const minuteRef = useRef<HTMLInputElement>(null);

  const digits = (value: string) => value.replace(/\D/g, "").slice(0, 2);
  const read = () => readClockFields(hour, minute, meridiem);
  /** Emptying the hour empties the control, so Enter can clear the time. */
  const clear = () => {
    setHour("");
    setMinute("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") return onCommit(read(), true);
    if (e.key === "Escape") return onCancel();
    // a/p anywhere in the group, the way the native control took them.
    if (e.key === "a" || e.key === "A") setMeridiem("am");
    if (e.key === "p" || e.key === "P") setMeridiem("pm");
  };

  const field =
    "w-4 rounded bg-transparent text-center text-[10px] text-[var(--text)] outline-none " +
    "placeholder:text-[var(--text-faint)]";

  return (
    <span
      className="mt-0.5 flex items-center gap-px rounded bg-[var(--bg)] px-1 py-px"
      onKeyDown={onKeyDown}
      // One control, three fields: only a blur that leaves the group entirely
      // is the user walking away.
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        onCommit(read(), false);
      }}
    >
      <input
        autoFocus
        inputMode="numeric"
        aria-label={`Hour for ${label}`}
        placeholder="--"
        value={hour}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const next = digits(e.target.value);
          // Move on as soon as the hour cannot grow any further, which is what
          // the native picker does and what typing "930" expects: 2–9 can only
          // be a whole hour, while 1 might still become 10, 11 or 12.
          if (next === "") return clear();
          if (next.length === 1) {
            setHour(next);
            if (Number(next) >= 2) minuteRef.current?.select();
            return;
          }
          if (Number(next) <= 12) {
            setHour(next);
            minuteRef.current?.select();
            return;
          }
          // The second digit cannot belong to the hour, so it starts the
          // minutes — "930" is 9:30, never 93:0.
          setHour(next.slice(0, 1));
          setMinute(next.slice(1));
          minuteRef.current?.focus();
        }}
        className={field}
      />
      <span className="text-[10px] text-[var(--text-faint)]">:</span>
      <input
        ref={minuteRef}
        inputMode="numeric"
        aria-label={`Minutes for ${label}`}
        placeholder="00"
        value={minute}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setMinute(digits(e.target.value))}
        className={field}
      />
      <button
        type="button"
        aria-label={`am or pm for ${label}, currently ${meridiem}`}
        // Safari does not focus a button on click, so without this the click
        // blurs the hour field, relatedTarget is null, and the group decides
        // the user walked away — the editor closed and committed the OLD
        // am/pm. Not taking focus at all sidesteps it in every engine.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMeridiem((m) => (m === "am" ? "pm" : "am"))}
        // Enter belongs to the group — it commits, it does not flip am/pm.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        title="Click to switch — or press a / p"
        className="ml-0.5 rounded px-0.5 text-[10px] text-[var(--text-muted)]
          transition-colors hover:bg-white/[0.08] hover:text-[var(--text)]"
      >
        {meridiem}
      </button>
    </span>
  );
}

/**
 * One line of a day's list. Events and to-dos differ in what a tick means and
 * in whether they can be renamed here, but they drag and retime identically.
 */
function ItemRow({
  item,
  column,
  calendarsById,
  onToggleEvent,
  onChanged,
  busy,
  onOpenDetail,
}: {
  item: BoardItem;
  column: string;
  calendarsById: Map<string, CalendarRecord>;
  onToggleEvent: (occurrence: Occurrence, completed: boolean) => void;
  onChanged: () => void | Promise<void>;
  /** This row's own move is still saving, so it cannot be picked up again. */
  busy: boolean;
  /** Double-clicking the row opens its notes. */
  onOpenDetail: () => void;
}) {
  const isEvent = item.kind === "event";
  const title = titleOf(item);
  const startMin = startMinOf(item);
  const done = isEvent ? item.occurrence.completed : item.task.done;

  const calendar = isEvent && item.occurrence.calendarId
    ? calendarsById.get(item.occurrence.calendarId)
    : undefined;
  const color = isEvent
    ? item.occurrence.habitColor ?? calendar?.color ?? "#6b6b6b"
    : "#8d8d8d";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  /**
   * The current title, for the editor to start from when it opens. The draft
   * outlives a refetch, so after a rename in the details panel it still held
   * the old title — and blurring the editor PATCHed it back (measured).
   */
  const titleRef = useRef(title);
  titleRef.current = title;
  const [editingTime, setEditingTime] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
    disabled: busy,
  });

  const carried = !isEvent && item.task.ymd < column;

  // Renaming stays on a single click, but the editor cannot open the instant
  // the first click lands or it would flash open behind the notes panel on the
  // second. Holding it for one double-click interval is the whole trick; an
  // event has no inline editor, so it opens its notes with no delay at all.
  const editorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelEditorOpen() {
    if (editorTimer.current) clearTimeout(editorTimer.current);
    editorTimer.current = null;
  }
  useEffect(() => cancelEditorOpen, []);

  function openEditorUnlessDoubleClick(event: React.MouseEvent) {
    if (item.kind !== "task") return;
    // detail is the click count: the second click of a double never schedules.
    if (event.detail > 1) return cancelEditorOpen();
    cancelEditorOpen();
    editorTimer.current = setTimeout(() => {
      editorTimer.current = null;
      setDraft(titleRef.current);
      setEditing(true);
    }, DOUBLE_CLICK_MS);
  }

  async function patchTask(body: Record<string, unknown>) {
    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.kind === "task" ? item.task.id : "", ...body }),
    });
    onChanged();
  }

  async function remove() {
    if (item.kind === "task") {
      await fetch(`/api/tasks?id=${encodeURIComponent(item.task.id)}`, { method: "DELETE" });
    } else {
      // Local events are deleted; feed ones are hidden from this app only.
      await fetch(`/api/events?key=${encodeURIComponent(item.key)}`, { method: "DELETE" });
    }
    onChanged();
  }

  async function commitTitle() {
    setEditing(false);
    if (item.kind !== "task") return;
    const next = draft.trim();
    if (!next) return remove();
    if (next !== title) await patchTask({ title: next });
  }

  /** `explicit` is true only for Enter — see commitFor for why blur is not
   *  allowed to clear a time. */
  async function commitTime(read: ReadTime, explicit: boolean) {
    const decision = commitFor(read, startMin, explicit);
    setEditingTime(false);
    setTimeError(null);

    // Not a time at all. Say so — the old silence was the whole complaint.
    if (decision.action === "invalid") return setTimeError("Enter an hour of 1–12");
    // Blank, and the user only clicked away: leave the item alone.
    if (decision.action === "keep") return;
    if (decision.action === "none") return;

    // Clearing is always deliberate now; for a feed event the server still
    // rejects it rather than silently making the event all-day.
    const res = await fetch("/api/board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "time",
        itemKey: item.key,
        ymd: column,
        startMin: decision.startMin,
      }),
    });
    if (!res.ok) {
      // Say why rather than just snapping the field back — the usual cause is
      // clearing the time on a feed event, which the server refuses.
      const body = await res.json().catch(() => ({}));
      setTimeError(body.error ?? "Could not change the time");
    }
    onChanged();
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group flex items-start gap-1.5 rounded-md px-1 py-1 hover:bg-white/[0.04] ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <Tick
        checked={done}
        color={color}
        label={`Mark ${title} done`}
        onChange={(next) =>
          isEvent ? onToggleEvent(item.occurrence, next) : patchTask({ done: next })
        }
      />

      <span className="min-w-0 flex-1">
        {editing && item.kind === "task" ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setDraft(title);
                setEditing(false);
              }
            }}
            className="w-full rounded bg-[var(--bg)] px-1 text-[12px] text-[var(--text)]"
          />
        ) : (
          // The title doubles as the drag handle: pointer travel starts a drag,
          // a clean click opens the inline editor (to-dos only — event titles
          // belong to the calendar), and a double click opens the notes.
          <button
            type="button"
            onClick={openEditorUnlessDoubleClick}
            onDoubleClick={(e) => {
              e.preventDefault();
              cancelEditorOpen();
              onOpenDetail();
            }}
            {...attributes}
            {...listeners}
            className={`block w-full cursor-grab truncate text-left text-[12px] leading-tight active:cursor-grabbing ${
              done ? "text-[var(--text-faint)] line-through" : "text-[var(--text)]"
            }`}
            title={carried ? `Carried over from ${item.task.ymd}` : title}
          >
            {carried && <span className="mr-1 text-[var(--text-faint)]">↩</span>}
            {title}
          </button>
        )}

        {editingTime ? (
          <TimeFields
            startMin={startMin}
            label={title}
            onCommit={commitTime}
            onCancel={() => setEditingTime(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTime(true)}
            className={`block text-[10px] leading-tight transition-colors hover:text-[var(--text)] ${
              startMin === null
                ? "text-[var(--text-faint)] opacity-0 group-hover:opacity-100"
                : "text-[var(--text-faint)]"
            }`}
            title={item.pinned ? "Placed by hand — time no longer sets its order" : "Set a time"}
          >
            {startMin === null ? "+ time" : formatMinutes(startMin)}
            {item.pinned && startMin !== null && <span className="ml-1 opacity-60">·</span>}
          </button>
        )}

        {item.hasNote && !editingTime && (
          <button
            type="button"
            onClick={onOpenDetail}
            title={
              item.checks
                ? `${item.checks.done} of ${item.checks.total} ticked — open notes`
                : "Has notes — open them"
            }
            className="mt-0.5 flex items-center gap-1 text-[10px] leading-tight text-[var(--text-faint)]
              transition-colors hover:text-[var(--text)]"
          >
            <svg viewBox="0 0 16 16" className="size-2.5 shrink-0" aria-hidden="true">
              <path
                d="M3 4h10M3 8h10M3 12h6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            {item.checks && (
              <span className="tabular-nums">
                {item.checks.done}/{item.checks.total}
              </span>
            )}
          </button>
        )}

        {timeError && (
          <button
            type="button"
            onClick={() => setTimeError(null)}
            className="mt-0.5 block text-left text-[10px] leading-tight text-[#e05a5a]"
            title="Dismiss"
          >
            {timeError}
          </button>
        )}
      </span>

      {isEvent && (
        <span
          className="mt-[5px] size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          title={calendar?.name ?? "No calendar"}
        />
      )}

      <button
        type="button"
        onClick={remove}
        aria-label={`Delete ${title}`}
        title={
          isEvent && item.occurrence.origin === "ics"
            ? "Remove from here (it stays in your calendar)"
            : undefined
        }
        className="mt-[2px] shrink-0 text-[var(--text-faint)] opacity-0 transition-opacity
          hover:text-[#e05a5a] group-hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
