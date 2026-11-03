"use client";

import { useCallback, useMemo } from "react";

import AppShell from "./AppShell";
import TodoBoard from "./TodoBoard";
import NeedToAction from "./NeedToAction";
import DragHub from "./DragHub";
import RefreshButton from "./RefreshButton";
import PageNav from "./PageNav";
import { useAppState } from "./useAppState";
import type { BoardItem } from "@/lib/board";
import type { NoteSummary } from "@/lib/checklist";
import type { CalendarState } from "@/lib/view";

/** "Sunday, 16 August" — the ymd is already APP_TZ wall-clock, so read it as UTC. */
function longDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/**
 * The main dashboard: the to-do board and nothing else. The calendar lives on
 * its own page behind the header button, so this stays the place for the
 * day-to-day list rather than a grid to browse.
 */
export default function DashboardApp({ initial }: { initial: CalendarState }) {
  const app = useAppState(initial);
  const {
    state,
    setState,
    toggleCompletion,
    refresh,
    runSync,
    syncing,
    syncError,
  } = app;

  const calendarsById = useMemo(
    () => new Map(state.calendars.map((c) => [c.id, c])),
    [state.calendars],
  );

  /**
   * A note save patches its row's marker here instead of refetching the board:
   * a refetch per pause in typing re-rendered the whole page each time. When
   * the marker already says the same thing — most saves, which only change the
   * words — the state is left alone, so the board does not render at all.
   */
  const patchNoteMarker = useCallback(
    (key: string, summary: NoteSummary) => {
      const stale = (item: BoardItem) =>
        item.key === key &&
        (item.hasNote !== summary.hasNote ||
          item.checks?.done !== summary.checks?.done ||
          item.checks?.total !== summary.checks?.total);
      setState((prev) => {
        let changed = false;
        const items: Record<string, BoardItem[]> = {};
        for (const [ymd, list] of Object.entries(prev.board.items)) {
          if (!list.some(stale)) {
            items[ymd] = list;
            continue;
          }
          changed = true;
          items[ymd] = list.map((item) =>
            stale(item) ? { ...item, hasNote: summary.hasNote, checks: summary.checks } : item,
          );
        }
        return changed ? { ...prev, board: { ...prev.board, items } } : prev;
      });
    },
    [setState],
  );

  return (
    // One drag context around the sidebar and the board, so a row can cross
    // between "Need to action" and a day.
    <DragHub>
      <AppShell
        app={app}
        secondary={<NeedToAction actions={state.actions} onChanged={() => refresh()} />}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 px-5 py-3.5">
          <h1 className="text-[22px] font-semibold tracking-tight">Today</h1>
          <span className="text-[13px] text-[var(--text-muted)]">
            {longDate(state.today)}
          </span>

          <div className="flex-1" />

          <RefreshButton syncing={syncing} error={syncError} onClick={runSync} />

          <PageNav />
        </header>

        <TodoBoard
          days={state.board.days}
          today={state.today}
          items={state.board.items}
          calendarsById={calendarsById}
          onToggleEvent={toggleCompletion}
          onChanged={() => refresh()}
          onNoteChange={patchNoteMarker}
          pauses={state.pauses}
          onDragStateChange={(dragging) => {
            app.dragBusy.current = dragging;
          }}
        />
      </AppShell>
    </DragHub>
  );
}
