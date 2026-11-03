"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDndContext, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ActionRecord } from "@/lib/store";
import { ACTION_ID_PREFIX, BACKLOG_ZONE, isBacklogId, useDragArea } from "./DragHub";

/** The drag id of a backlog row — prefixed, so it never collides with a board key. */
const dragId = (id: string): string => `${ACTION_ID_PREFIX}${id}`;
const idOf = (dragKey: string): string => dragKey.slice(ACTION_ID_PREFIX.length);

/**
 * The sidebar backlog: things to deal with that have no day yet. Behaves like a
 * board column — type to add, tick to clear it off the list, drag to reorder —
 * but carries no date. Dragging a row onto a board day makes it a to-do there,
 * and a to-do dragged in here joins the backlog (2026-10-01); both share the
 * board's drag context through DragHub.
 */
export default function NeedToAction({
  actions: allActions,
  onChanged,
}: {
  actions: ActionRecord[];
  onChanged: () => void;
}) {
  // Ticking deletes, so nothing finished belongs here; a done row can still
  // arrive when a reminder completed on the phone is imported mid-sync.
  const actions = useMemo(() => allActions.filter((a) => !a.done), [allActions]);
  const [draft, setDraft] = useState("");
  // Enter and blur both submit, and blur fires right after Enter. The ref is
  // cleared synchronously so the follow-up blur is a no-op rather than adding
  // the item twice.
  const pending = useRef("");
  const [order, setOrder] = useState(actions.map((a) => a.id));
  const [orderError, setOrderError] = useState<string | null>(null);

  useEffect(() => {
    // Only when the list's membership changes. A refetch whose snapshot predates
    // a just-saved drag carries the old sequence, and taking it wholesale
    // bounced the row back under the pointer.
    setOrder((prev) => {
      const ids = actions.map((a) => a.id);
      const same = ids.length === prev.length && ids.every((id) => prev.includes(id));
      return same ? prev : ids;
    });
  }, [actions]);

  const byId = new Map(actions.map((a) => [a.id, a]));

  function setValue(value: string) {
    pending.current = value;
    setDraft(value);
  }

  async function add() {
    const title = pending.current.trim();
    if (!title) return;
    setValue("");
    await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    onChanged();
  }

  async function onDragEnd(event: DragEndEvent) {
    const activeKey = String(event.active.id);
    const overKey = event.over?.id ? String(event.over.id) : null;
    if (!overKey) return;
    const ours = activeKey.startsWith(ACTION_ID_PREFIX);

    // One of ours, dropped on the board: the board makes it a to-do. Take the
    // row off now so it does not sit here until the refetch.
    if (ours && !isBacklogId(overKey)) {
      setOrder((prev) => prev.filter((id) => id !== idOf(activeKey)));
      return;
    }
    if (!isBacklogId(overKey)) return;
    if (!ours) return receive(activeKey, overKey);

    const activeId = idOf(activeKey);
    // The zone itself means "below the last row".
    const overId = overKey === BACKLOG_ZONE ? order[order.length - 1] : idOf(overKey);
    if (!overId || activeId === overId) return;

    const from = order.indexOf(activeId);
    const to = order.indexOf(overId);
    if (from === -1 || to === -1) return;

    const previous = order;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, activeId);
    setOrder(next);

    // The rows either side of the gap rather than its index: a reminder ticked
    // off on the phone can delete a row above this one between the page loading
    // and the drop, and an index counted against the stale list moves further
    // than the user dragged.
    const at = next.indexOf(activeId);
    try {
      const res = await fetch("/api/actions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeId,
          beforeId: at > 0 ? next[at - 1] : null,
          afterId: at < next.length - 1 ? next[at + 1] : null,
        }),
      });
      if (!res.ok) {
        setOrder(previous);
        setOrderError("Could not save that order");
      }
    } catch {
      setOrder(previous);
      setOrderError("Could not reach the server");
    } finally {
      onChanged();
    }
  }

  /**
   * A board row dropped here. Only a to-do can come: it leaves its day and
   * joins the backlog before the row it landed on (at the bottom when it
   * landed on the section itself). An event belongs to its calendar and its
   * day, and is refused with a reason rather than silently bounced.
   */
  async function receive(itemKey: string, overKey: string) {
    if (!itemKey.startsWith("task:")) {
      setOrderError("Only to-dos can go to Need to action — an event stays on its day");
      return;
    }
    const at = overKey === BACKLOG_ZONE ? order.length : Math.max(0, order.indexOf(idOf(overKey)));
    try {
      const res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toBacklog",
          itemKey,
          beforeId: at > 0 ? order[at - 1] : null,
          afterId: at < order.length ? order[at] : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setOrderError(body?.error ?? "Could not move that here");
      }
    } catch {
      setOrderError("Could not reach the server");
    } finally {
      onChanged();
    }
  }

  useDragArea("backlog", {
    onDragEnd,
    overlay: (key) => {
      if (!key.startsWith(ACTION_ID_PREFIX)) return null;
      const action = byId.get(idOf(key));
      if (!action) return null;
      return (
        <div className="rounded-md bg-[var(--card-hover)] px-1.5 py-1 text-[13px] text-[var(--text)] shadow-xl">
          {action.title}
        </div>
      );
    },
  });

  // The whole section is the drop zone, so an empty backlog still takes a drop.
  const { setNodeRef: setZoneRef } = useDroppable({ id: BACKLOG_ZONE });
  const { active, over } = useDndContext();
  const incoming =
    !!active &&
    !String(active.id).startsWith(ACTION_ID_PREFIX) &&
    !!over &&
    isBacklogId(String(over.id));

  const items = order.map((id) => byId.get(id)).filter((a): a is ActionRecord => !!a);

  return (
    <section
      ref={setZoneRef}
      className={`border-t border-[var(--border)] p-4 transition-colors ${
        incoming ? "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/60" : ""
      }`}
    >
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        Need to action
      </h2>

      {orderError && (
        <button
          type="button"
          onClick={() => setOrderError(null)}
          title="Dismiss"
          className="mt-1 block text-left text-[11px] text-[#e05a5a]"
        >
          {orderError}
        </button>
      )}

      <div className="mt-2.5 flex flex-col gap-px">
        <SortableContext items={order.map(dragId)} strategy={verticalListSortingStrategy}>
          {items.map((action) => (
            <ActionRow key={action.id} action={action} onChanged={onChanged} />
          ))}
        </SortableContext>
        {items.length === 0 && incoming && (
          <p className="px-1 py-1 text-[12px] text-[var(--text-faint)]">Drop here</p>
        )}
      </div>

      <input
        value={draft}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") setValue("");
        }}
        onBlur={add}
        placeholder="+ add"
        aria-label="Add something that needs actioning"
        className="mt-1 w-full rounded-md bg-transparent px-1 py-1 text-[12px] text-[var(--text)]
          placeholder:text-[var(--text-faint)] focus:bg-[var(--bg)]"
      />
    </section>
  );
}

function ActionRow({ action, onChanged }: { action: ActionRecord; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action.title);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dragId(action.id),
  });

  async function patch(body: Record<string, unknown>) {
    await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: action.id, ...body }),
    });
    onChanged();
  }

  async function remove() {
    await fetch(`/api/actions?id=${encodeURIComponent(action.id)}`, { method: "DELETE" });
    onChanged();
  }

  async function commit() {
    setEditing(false);
    const title = draft.trim();
    if (!title) return remove();
    if (title !== action.title) await patch({ title });
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-white/[0.04] ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={action.done}
        aria-label={`Tick off ${action.title}`}
        // Ticking clears it from the list entirely — the backlog is a list of
        // things to deal with, not a record of what was dealt with.
        onChange={remove}
        className="mt-[3px] size-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border
          border-[#6a6a6a] transition-colors checked:border-transparent"
        style={
          action.done
            ? {
                backgroundColor: "#8d8d8d",
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath fill='none' stroke='%23131313' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' d='M3 7.2l2.6 2.6L11 4.4'/%3E%3C/svg%3E\")",
                backgroundSize: "100%",
              }
            : undefined
        }
      />

      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(action.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded bg-[var(--bg)] px-1 text-[13px] text-[var(--text)]"
        />
      ) : (
        // Doubles as the drag handle: travel drags, a clean click edits.
        <button
          type="button"
          onClick={() => setEditing(true)}
          {...attributes}
          {...listeners}
          className={`min-w-0 flex-1 cursor-grab text-left text-[13px] leading-snug active:cursor-grabbing ${
            action.done ? "text-[var(--text-faint)] line-through" : "text-[var(--text)]"
          }`}
        >
          {action.title}
        </button>
      )}

      <button
        type="button"
        onClick={remove}
        aria-label={`Delete ${action.title}`}
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
