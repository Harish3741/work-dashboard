"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarState, ViewMode } from "@/lib/view";
import type { Occurrence } from "@/lib/types";

/**
 * State shared by the dashboard and the calendar page: the server snapshot plus
 * the mutations both need (ticking something off, toggling a calendar,
 * resyncing). Lives here rather than in src/lib because that directory is
 * compiled and unit-tested with plain tsc and must stay free of React and Next.
 */
export function useAppState(initial: CalendarState) {
  const [state, setState] = useState(initial);
  const [view, setView] = useState<ViewMode>(initial.view);
  const [anchor, setAnchor] = useState(initial.anchor);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  /** Bumps after every manual refresh, so self-fetching sections reload too. */
  const [syncVersion, setSyncVersion] = useState(0);
  /** Raised while a drag is in flight, so the wake refetch waits its turn. */
  const dragBusy = useRef(false);
  /** Refetches now overlap (a wake tick beside a click), so the last one wins. */
  const requestSeq = useRef(0);

  const refresh = useCallback(
    async (nextView: ViewMode = view, nextAnchor: string = anchor) => {
      const seq = ++requestSeq.current;
      const res = await fetch(
        `/api/state?view=${nextView}&anchor=${nextAnchor}`,
        {
          cache: "no-store",
        },
      );
      // A slower earlier request must not land on top of a newer snapshot.
      if (res.ok && seq === requestSeq.current) setState(await res.json());
    },
    [view, anchor],
  );

  useEffect(() => {
    refresh(view, anchor);
    // `refresh` is recreated whenever view/anchor change, which is exactly when
    // we want to refetch — depending on it directly would double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, anchor]);

  const toggleCompletion = useCallback(
    async (occurrence: Occurrence, completed: boolean) => {
      // Optimistic — ticking should feel instant.
      setState((prev) => ({
        ...prev,
        occurrences: prev.occurrences.map((o) =>
          o.key === occurrence.key ? { ...o, completed } : o,
        ),
        board: {
          ...prev.board,
          occurrences: prev.board.occurrences.map((o) =>
            o.key === occurrence.key ? { ...o, completed } : o,
          ),
        },
      }));
      await fetch("/api/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: occurrence.key, completed }),
      });
      // Refetch either way: on success for recomputed progress, on failure to
      // roll the optimistic tick back.
      await refresh();
    },
    [refresh],
  );

  /**
   * The one Refresh: re-read the calendar feeds, then a fresh snapshot. Add a
   * `call(...)` below for each source you connect; each is its own request so
   * one failing does not stop the others, and failures go in the button's
   * tooltip.
   */
  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    // Put the date and the board right first; the calls below can take a
    // while, and after a wake the stale screen is the thing to fix.
    void refresh();
    const errors: string[] = [];
    const call = async (
      label: string,
      input: RequestInfo,
      init?: RequestInit,
    ) => {
      try {
        const res = await fetch(input, init);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          errors.push(`${label}: ${body.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        errors.push(
          `${label}: ${err instanceof Error ? err.message : "failed"}`,
        );
      }
    };
    await Promise.all([
      call("Calendars", "/api/sync", { method: "POST" }),
    ]);
    setSyncError(errors.length > 0 ? errors.join(" · ") : null);
    setSyncing(false);
    setSyncVersion((v) => v + 1);
    await refresh();
  }, [refresh]);

  const toggleCalendar = useCallback(
    async (id: string, enabled: boolean) => {
      setState((prev) => ({
        ...prev,
        calendars: prev.calendars.map((c) =>
          c.id === id ? { ...c, enabled } : c,
        ),
      }));
      await fetch("/api/calendars", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      await refresh();
    },
    [refresh],
  );

  return {
    state,
    setState,
    view,
    setView,
    anchor,
    setAnchor,
    syncing,
    syncError,
    syncVersion,
    dragBusy,
    refresh,
    toggleCompletion,
    runSync,
    toggleCalendar,
  };
}

export type AppState = ReturnType<typeof useAppState>;
