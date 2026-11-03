"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import AppShell from "./AppShell";
import MonthGrid from "./MonthGrid";
import WeekGrid from "./WeekGrid";
import EventDialog, { type EventDialogTarget } from "./EventDialog";
import { useAppState } from "./useAppState";
import RefreshButton from "./RefreshButton";
import PageNav from "./PageNav";
import { addDays, addMonths, monthLabel, startOfWeek } from "@/lib/time";
import type { CalendarState, ViewMode } from "@/lib/view";
import type { Occurrence } from "@/lib/types";

/**
 * The calendar, on its own page. Reached from the dashboard's Calendar button
 * so the main screen stays a to-do list.
 */
export default function CalendarApp({ initial }: { initial: CalendarState }) {
  const app = useAppState(initial);
  const {
    state,
    view,
    setView,
    anchor,
    setAnchor,
    refresh,
    toggleCompletion,
    runSync,
    syncing,
    syncError,
  } = app;

  const [dragging, setDragging] = useState<Occurrence | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const [eventTarget, setEventTarget] = useState<EventDialogTarget | null>(
    null,
  );

  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const occurrence of state.occurrences) {
      const list = map.get(occurrence.ymd);
      if (list) list.push(occurrence);
      else map.set(occurrence.ymd, [occurrence]);
    }
    return map;
  }, [state.occurrences]);

  const calendarsById = useMemo(
    () => new Map(state.calendars.map((c) => [c.id, c])),
    [state.calendars],
  );

  const sensors = useSensors(
    // A small threshold keeps the checkbox and card clicks working; a drag only
    // starts once the pointer actually travels.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  async function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const over = event.over?.id;
    const occurrence = event.active.data.current?.occurrence as
      Occurrence | undefined;
    if (!over || !occurrence) return;

    // Month cells are "YYYY-MM-DD"; week slots are "YYYY-MM-DD@minutes", and
    // the week's all-day row is "YYYY-MM-DD@allday" — the day changes, the time
    // does not, exactly as a month cell behaves.
    const [toYmd, slot] = String(over).split("@");
    const toStartMin =
      slot === undefined || slot === "allday" ? undefined : Number(slot);
    if (toStartMin !== undefined && !Number.isFinite(toStartMin)) return;
    if (toYmd === occurrence.ymd && toStartMin === undefined) return;
    if (toYmd === occurrence.ymd && toStartMin === occurrence.startMin) return;

    try {
      const res = await fetch("/api/events", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: occurrence.key, toYmd, toStartMin }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // Otherwise the card just snaps back with no explanation.
        setDragError(body?.error ?? "Could not move that event");
      }
    } catch {
      setDragError("Could not reach the server");
    }
    await refresh();
  }

  const step = (direction: number) =>
    setAnchor((prev) =>
      view === "month"
        ? addMonths(prev, direction)
        : addDays(startOfWeek(prev), direction * 7),
    );

  return (
    <DndContext
      // Stable id, like the board's — see the note in TodoBoard.
      id="calendar"
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => {
        setDragging((e.active.data.current?.occurrence as Occurrence) ?? null);
        app.dragBusy.current = true;
      }}
      onDragEnd={async (e: DragEndEvent) => {
        try {
          await onDragEnd(e);
        } finally {
          app.dragBusy.current = false;
        }
      }}
      onDragCancel={() => {
        setDragging(null);
        app.dragBusy.current = false;
      }}
    >
      <AppShell app={app}>
        {/* Two rows, unlike the other pages: the sections go where they go
            everywhere else, and the month controls drop below them rather than
            wrapping unpredictably next to four more buttons. */}
        <header className="flex shrink-0 flex-col gap-2 px-5 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-[22px] font-semibold tracking-tight">
              <MutedYear label={view === "month" ? monthLabel(anchor) : weekLabel(anchor)} />
            </h1>

            <div className="flex-1" />

            <PageNav />
          </div>

          <div className="flex items-center gap-3">
            {dragError && (
              <button
                type="button"
                onClick={() => setDragError(null)}
                title="Dismiss"
                className="text-[12px] text-[#e05a5a]"
              >
                {dragError}
              </button>
            )}

            <div className="flex-1" />

            <RefreshButton
              syncing={syncing}
              error={syncError}
              onClick={runSync}
            />

            <div className="flex overflow-hidden rounded-lg bg-[var(--card)] p-0.5">
              {(["month", "week"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  className={`rounded-[6px] px-3 py-1 text-[12px] capitalize transition-colors ${
                    view === mode
                      ? "bg-[var(--card-hover)] text-[var(--text)]"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <NavButton label="Previous" onClick={() => step(-1)}>
                <path d="M10 3.5L5.5 8l4.5 4.5" />
              </NavButton>
              <button
                type="button"
                onClick={() => setAnchor(state.today)}
                className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--text)] transition-colors hover:bg-white/[0.06]"
              >
                Today
              </button>
              <NavButton label="Next" onClick={() => step(1)}>
                <path d="M6 3.5L10.5 8L6 12.5" />
              </NavButton>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col border-t border-l border-[var(--border)]">
          {view === "month" ? (
            <MonthGrid
              days={state.days}
              anchor={anchor}
              today={state.today}
              byDay={byDay}
              calendarsById={calendarsById}
              onToggle={toggleCompletion}
              onOpen={(occurrence) =>
                setEventTarget({ mode: "edit", occurrence })
              }
              onAdd={(ymd) => setEventTarget({ mode: "create", ymd })}
            />
          ) : (
            <WeekGrid
              days={state.days}
              today={state.today}
              byDay={byDay}
              calendarsById={calendarsById}
              onToggle={toggleCompletion}
              onOpen={(occurrence) =>
                setEventTarget({ mode: "edit", occurrence })
              }
              onAdd={(ymd, startMin) =>
                setEventTarget({ mode: "create", ymd, startMin })
              }
            />
          )}
        </div>
      </AppShell>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div
            className="rounded-lg bg-[var(--card-hover)] px-2 py-1.5 text-[13px] font-semibold shadow-xl"
            style={{
              boxShadow: `inset 3px 0 0 ${dragging.habitColor ?? "#6b6b6b"}`,
            }}
          >
            {dragging.title}
          </div>
        )}
      </DragOverlay>

      {eventTarget && (
        <EventDialog
          target={eventTarget}
          calendars={state.calendars}
          onClose={() => setEventTarget(null)}
          onSaved={() => {
            setEventTarget(null);
            refresh();
          }}
        />
      )}
    </DndContext>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-8 place-items-center rounded-lg text-[var(--text-muted)] transition-colors
        hover:bg-white/[0.06] hover:text-[var(--text)]"
    >
      <svg
        viewBox="0 0 16 16"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/** "September 2026" → the year in grey, as Calendar.app titles a month. */
function MutedYear({ label }: { label: string }) {
  const m = label.match(/^(.*\S)\s+(\d{4})$/);
  if (!m) return <>{label}</>;
  return (
    <>
      {m[1]} <span className="font-normal text-[var(--text-muted)]">{m[2]}</span>
    </>
  );
}

function weekLabel(anchor: string): string {
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  const fmt = (ymd: string, withMonth: boolean) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
      day: "numeric",
      ...(withMonth ? { month: "short" } : {}),
      timeZone: "UTC",
    });
  };
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const [y, m] = start.split("-").map(Number);
  const monthYear = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(
    "en-AU",
    {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    },
  );
  return sameMonth
    ? `${fmt(start, false)}–${fmt(end, false)} ${monthYear}`
    : `${fmt(start, true)} – ${fmt(end, true)} ${end.slice(0, 4)}`;
}
