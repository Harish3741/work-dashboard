"use client";

import { useEffect, useState } from "react";
import AppShell from "./AppShell";
import PageNav from "./PageNav";
import { useAppState } from "./useAppState";
import type { CalendarState } from "@/lib/view";
import type { StreakMatrix, WeekResult } from "@/lib/streaks";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthOf(ymd: string): number {
  return Number(ymd.slice(5, 7)) - 1;
}

function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

const SECTION = "text-[13px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";

/**
 * A habit × week matrix for the year. Same vocabulary as the board: uppercase
 * section labels, muted figures, no prose.
 */
export default function StreaksApp({
  initial: initialState,
  matrix: initialMatrix,
}: {
  initial: CalendarState;
  matrix: StreakMatrix;
}) {
  const app = useAppState(initialState);
  // The matrix is a server prop, so the shared refetch does not reach it — on
  // a page left open across a sleep it would be the one stale thing on screen.
  const [matrix, setMatrix] = useState(initialMatrix);

  const today = app.state.today;
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/streaks", { cache: "no-store" });
      if (!res.ok || !live) return;
      const body = (await res.json()) as { matrix: StreakMatrix };
      setMatrix(body.matrix);
    })();
    return () => {
      live = false;
    };
    // `today` changes when the wake refetch brings back a newer snapshot, which
    // is exactly when these need re-reading too.
  }, [today]);

  const { year, weekStarts, future, rows, perfectWeeks, perfectCount, activeWeeks } = matrix;

  // A month label sits above the first week that falls in it.
  const monthLabels = weekStarts.map((start, i) =>
    i === 0 || monthOf(start) !== monthOf(weekStarts[i - 1]) ? MONTHS[monthOf(start)] : null,
  );

  return (
    <AppShell app={app}>
      <header className="flex shrink-0 flex-wrap items-center gap-3 px-5 py-3.5">
        <h1 className="text-[22px] font-semibold tracking-tight">Streaks</h1>
        <span className="text-[13px] text-[var(--text-muted)] tabular-nums">{year}</span>

        <div className="flex-1" />

        <PageNav />
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        <section>
          <div className="flex items-baseline gap-3">
            <h2 className={SECTION}>Habits</h2>
            <span className="text-[12px] tabular-nums text-[var(--text-muted)]">
              {perfectCount} perfect {perfectCount === 1 ? "week" : "weeks"}
              {activeWeeks > 0 && <span className="text-[var(--text-faint)]"> · {activeWeeks} active</span>}
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="mt-3 text-[13px] text-[var(--text-faint)]">No habits yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <div className="inline-block min-w-full">
                <div className="flex">
                  <div className="w-[104px] shrink-0" />
                  <div className="flex gap-[3px]">
                    {monthLabels.map((label, i) => (
                      <span key={weekStarts[i]} className="w-[11px] text-[9px] text-[var(--text-faint)]">
                        {label ?? ""}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-1 flex flex-col gap-[3px]">
                  {rows.map((row) => (
                    <div key={row.habit.id} className="flex items-center">
                      <div className="flex w-[104px] shrink-0 items-baseline gap-1.5 pr-2">
                        <span className="min-w-0 flex-1 truncate text-[12px]" title={row.habit.name}>
                          {row.habit.name}
                        </span>
                        {row.runningStreak > 0 && (
                          <span
                            className="shrink-0 text-[10px] tabular-nums"
                            style={{ color: row.habit.color }}
                            title={`${row.runningStreak} week streak`}
                          >
                            {row.runningStreak}w
                          </span>
                        )}
                      </div>
                      <div className="flex gap-[3px]">
                        {row.weeks.map((week) => (
                          <Cell
                            key={week.start}
                            week={week}
                            color={row.habit.color}
                            label={`${row.habit.name} · week of ${shortDate(week.start)} · ${week.done}/${week.target}`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}

                  <div className="mt-1 flex items-center border-t border-[var(--border)] pt-2">
                    <span className="w-[104px] shrink-0 pr-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
                      Perfect
                    </span>
                    <div className="flex gap-[3px]">
                      {perfectWeeks.map((perfect, i) => (
                        <span
                          key={weekStarts[i]}
                          title={
                            future[i]
                              ? `Week of ${shortDate(weekStarts[i])} · still to come`
                              : `Week of ${shortDate(weekStarts[i])} · ${perfect ? "all habits hit" : "not all hit"}`
                          }
                          className="size-[11px] rounded-[2px]"
                          style={{
                            backgroundColor: perfect ? "var(--accent)" : "transparent",
                            boxShadow: perfect ? undefined : `inset 0 0 0 1px var(--border)`,
                            opacity: future[i] ? 0.35 : 1,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Cell({ week, color, label }: { week: WeekResult; color: string; label: string }) {
  if (!week.active) {
    return (
      <span
        title={`${label.split(" · ")[0]} · not tracked yet`}
        className="size-[11px] rounded-[2px]"
        style={{ boxShadow: "inset 0 0 0 1px var(--border)", opacity: 0.15 }}
      />
    );
  }
  if (week.paused && !week.future) {
    return (
      <span
        title={`${label.split(" · ")[0]} · away${week.done > 0 ? ` · ${week.done} done anyway` : ""}`}
        className="size-[11px] rounded-[2px]"
        style={{ border: "1px dotted var(--text-faint)", opacity: 0.6 }}
      />
    );
  }
  const partial = !week.met && week.done > 0;
  const opacity = week.future ? 0.35 : week.met ? 1 : partial ? 0.4 : 1;
  return (
    <span
      title={week.future ? `${label.split(" · ")[0]} · still to come` : label}
      className="size-[11px] rounded-[2px]"
      style={{
        backgroundColor: week.met || partial ? color : "transparent",
        opacity,
        boxShadow: week.met || partial ? undefined : "inset 0 0 0 1px var(--border)",
      }}
    />
  );
}
