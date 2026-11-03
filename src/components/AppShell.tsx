"use client";

import { useRef, useState } from "react";
import Sidebar from "./Sidebar";
import HabitDialog from "./HabitDialog";
import CalendarsDialog from "./CalendarsDialog";
import useWakeRefresh from "./useWakeRefresh";
import useChangeRefresh from "./useChangeRefresh";
import type { AppState } from "./useAppState";
import type { HabitRecord } from "@/lib/types";

/**
 * The sidebar, the dialogs it opens, and the page frame — everything the
 * dashboard and the calendar page have in common. Each page supplies its own
 * main content.
 */
export default function AppShell({
  app,
  secondary,
  onWake,
  children,
}: {
  app: AppState;
  /** Replaces the sidebar's calendar list — see Sidebar's `secondary`. */
  secondary?: React.ReactNode;
  /**
   * Run alongside the shared refetch when the computer wakes. A page holding data
   * of its own (the Dashboard) would otherwise sit on last night's copy: the
   * lid-open refetch only reloads what `useAppState` fetched.
   */
  onWake?: () => void;
  children: React.ReactNode;
}) {
  const { state, refresh, toggleCalendar, dragBusy } = app;
  const [habitTarget, setHabitTarget] = useState<
    HabitRecord | null | undefined
  >(undefined);
  const [showCalendars, setShowCalendars] = useState(false);

  // Both pages come through here, so the lid-open refetch is wired once.
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  useWakeRefresh({
    onWake: () => {
      void refresh();
      onWakeRef.current?.();
    },
    isBusy: () => dragBusy.current,
    todayOnScreen: () => state.today,
  });
  // And whenever something changed elsewhere (another tab, an API call), so
  // the open page never needs a Refresh to catch up.
  useChangeRefresh({
    onChange: () => {
      void refresh();
      onWakeRef.current?.();
    },
    isBusy: () => dragBusy.current,
  });

  return (
    <>
      <div className="flex h-dvh">
        <Sidebar
          today={state.today}
          progress={state.progress}
          pauses={state.pauses}
          onEndPause={async (id) => {
            await fetch(`/api/pauses?id=${encodeURIComponent(id)}`, { method: "DELETE" });
            refresh();
          }}
          calendars={state.calendars}
          sync={state.sync}
          onToggleCalendar={toggleCalendar}
          onNewHabit={() => setHabitTarget(null)}
          onEditHabit={(id) =>
            setHabitTarget(state.habits.find((h) => h.id === id) ?? null)
          }
          onManageCalendars={() => setShowCalendars(true)}
          secondary={secondary}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {children}
        </main>
      </div>

      {habitTarget !== undefined && (
        <HabitDialog
          habit={habitTarget}
          calendars={state.calendars}
          onClose={() => setHabitTarget(undefined)}
          onSaved={() => {
            setHabitTarget(undefined);
            refresh();
          }}
        />
      )}

      {showCalendars && (
        <CalendarsDialog
          calendars={state.calendars}
          sync={state.sync}
          onClose={() => setShowCalendars(false)}
          onChanged={refresh}
        />
      )}
    </>
  );
}
