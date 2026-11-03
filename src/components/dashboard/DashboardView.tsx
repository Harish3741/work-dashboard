"use client";

import { useCallback, useEffect, useState } from "react";

import AppShell from "../AppShell";
import RefreshButton from "../RefreshButton";
import PageNav from "../PageNav";
import { useAppState } from "../useAppState";
import ContactsTab from "./ContactsTab";
import type { DashboardState } from "@/lib/contacts";
import type { CalendarState } from "@/lib/view";

/**
 * Add a tab here (and a branch in the render below) to give the Dashboard a
 * new section. Contacts is the only one that ships with the template.
 */
const TABS = [{ id: "contacts", label: "Contacts" }] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * What you are working on, as opposed to what you are doing today. The board
 * at `/` stays the daily list; nothing here has a day or reaches the calendar.
 */
export default function DashboardView({
  initial,
  initialDashboard,
}: {
  initial: CalendarState;
  initialDashboard: DashboardState;
}) {
  const app = useAppState(initial);
  const { syncing, syncError, runSync, syncVersion } = app;
  const [data, setData] = useState(initialDashboard);
  const [tab, setTab] = useState<TabId>("contacts");

  const reload = useCallback(async () => {
    const res = await fetch("/api/dashboard", { cache: "no-store" });
    if (!res.ok) return;
    setData((await res.json()) as DashboardState);
  }, []);

  // The header's Refresh re-reads the calendars; this section has its own
  // data, so it reloads on the same press rather than going stale.
  useEffect(() => {
    if (syncVersion > 0) void reload();
  }, [syncVersion, reload]);

  return (
    <AppShell app={app} onWake={reload}>
      <header className="flex shrink-0 flex-wrap items-center gap-3 px-5 py-3.5">
        <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>

        <nav className="flex items-center gap-0.5 rounded-lg bg-[var(--surface)] p-0.5">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? "page" : undefined}
              className={`rounded-[7px] px-2.5 py-1 text-[12px] transition-colors ${
                tab === entry.id
                  ? "bg-[var(--card)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        <RefreshButton syncing={syncing} error={syncError} onClick={runSync} />

        <PageNav />
      </header>

      {tab === "contacts" && <ContactsTab contacts={data.contacts} onChanged={reload} />}
    </AppShell>
  );
}
