"use client";

import { endOfWeek, startOfWeek, dayNumber } from "@/lib/time";
import { currentOrNextPause, type PauseRecord } from "@/lib/away";
import type { CalendarRecord, HabitProgress, SyncStatus } from "@/lib/types";

type Props = {
  today: string;
  progress: HabitProgress[];
  /** Time away; the chip under the heading shows the current or next one. */
  pauses: PauseRecord[];
  onEndPause: (id: string) => void;
  calendars: CalendarRecord[];
  sync: SyncStatus[];
  onToggleCalendar: (id: string, enabled: boolean) => void;
  onNewHabit: () => void;
  onEditHabit: (habitId: string) => void;
  onManageCalendars: () => void;
  /**
   * Replaces the calendar list below the habits. The dashboard puts the
   * "Need to action" backlog here; the calendar page leaves it unset and keeps
   * the calendar toggles, which only make sense next to a grid.
   */
  secondary?: React.ReactNode;
};

export default function Sidebar({
  today,
  progress,
  pauses,
  onEndPause,
  calendars,
  sync,
  onToggleCalendar,
  onNewHabit,
  onEditHabit,
  onManageCalendars,
  secondary,
}: Props) {
  const weekStart = startOfWeek(today);
  const weekEnd = endOfWeek(today);
  const away = currentOrNextPause(pauses, today);
  const failures = sync.filter((s) => s.lastStatus === "error");
  const lastOk = sync
    .map((s) => s.lastSyncAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);

  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
        <section className="p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              This week
            </h2>
            <span className="text-[11px] tabular-nums text-[var(--text-faint)]">
              {dayNumber(weekStart)}–{dayNumber(weekEnd)}
            </span>
          </div>

          {away && (
            <div
              className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"
              title={
                away.source === "calendar"
                  ? `From your calendar: ${away.label} — habits are not required while you are away`
                  : away.label
                    ? `${away.label} — habits are not required while you are away`
                    : "Habits are not required while you are away"
              }
            >
              <span aria-hidden="true">✈</span>
              <span className="min-w-0 flex-1 truncate">
                {away.fromYmd <= today ? `Away until ${shortDate(away.toYmd)}` : `Away ${shortDate(away.fromYmd)} – ${shortDate(away.toYmd)}`}
              </span>
              <button
                type="button"
                onClick={() => onEndPause(away.id)}
                aria-label={away.fromYmd <= today ? "I'm back — end the pause" : "Not away — remove this pause"}
                title={
                  away.fromYmd <= today
                    ? "I'm back — end the pause"
                    : "Not away — remove this pause"
                }
                className="rounded px-1 text-[var(--text-faint)] transition-colors hover:bg-white/[0.08] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2.5">
            {progress.length === 0 && (
              <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
                No habits yet. Add one, then tick its events on the calendar to
                build progress.
              </p>
            )}

            {progress.map((entry) => (
              <HabitRow
                key={entry.habit.id}
                entry={entry}
                onEdit={() => onEditHabit(entry.habit.id)}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={onNewHabit}
            className="mt-3 w-full rounded-lg border border-dashed border-[var(--border)] py-2 text-[12px]
              text-[var(--text-muted)] transition-colors hover:border-[#3d3d3d] hover:text-[var(--text)]"
          >
            + New habit
          </button>
        </section>

        {secondary ?? (
          <section className="border-t border-[var(--border)] p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Calendars
              </h2>
              <button
                type="button"
                onClick={onManageCalendars}
                className="text-[11px] text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
              >
                Manage
              </button>
            </div>

            <div className="mt-2.5 flex flex-col gap-0.5">
              {calendars.map((calendar) => {
                const status = sync.find((s) => s.calendarId === calendar.id);
                return (
                  <label
                    key={calendar.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-white/[0.04]"
                  >
                    <input
                      type="checkbox"
                      checked={calendar.enabled}
                      onChange={(e) =>
                        onToggleCalendar(calendar.id, e.target.checked)
                      }
                      className="size-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border-2 transition-colors"
                      style={{
                        borderColor: calendar.color,
                        backgroundColor: calendar.enabled
                          ? calendar.color
                          : "transparent",
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
                      {calendar.name}
                    </span>
                    {status?.lastStatus === "error" && (
                      <span
                        title={status.lastError ?? "Sync failed"}
                        className="text-[11px] text-[#e05a5a]"
                      >
                        !
                      </span>
                    )}
                  </label>
                );
              })}
              {calendars.length === 0 && (
                <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
                  No calendars yet — add a calendar feed (ICS) URL to get started.
                </p>
              )}
            </div>
          </section>
        )}
      </div>

      <footer className="border-t border-[var(--border)] px-4 py-2.5">
        <p className="text-center text-[11px] text-[var(--text-faint)]">
          {failures.length > 0
            ? `${failures.length} calendar${failures.length > 1 ? "s" : ""} failed to sync`
            : lastOk
              ? `Calendars synced ${relativeTime(lastOk)}`
              : "Calendars not synced yet"}
        </p>
      </footer>
    </aside>
  );
}

function HabitRow({
  entry,
  onEdit,
}: {
  entry: HabitProgress;
  onEdit: () => void;
}) {
  const { habit, done, target, planned, streak, pausedDays } = entry;
  const awayAllWeek = target === 0 && pausedDays > 0;
  const pct = target > 0 ? Math.min(100, (done / target) * 100) : 0;
  const met = target > 0 && done >= target;

  return (
    <button
      type="button"
      onClick={onEdit}
      className="group w-full rounded-lg px-1 py-1 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
          {habit.name}
        </span>
        <span
          className="shrink-0 text-[12px] tabular-nums"
          style={{ color: met ? habit.color : "var(--text-muted)" }}
        >
          {awayAllWeek ? "—" : `${done}/${target}`}
        </span>
      </div>

      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: habit.color }}
        />
      </div>

      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
        {streak > 0 && (
          <span title="Consecutive finished weeks hitting the target">
            {streak}-week streak
          </span>
        )}
        {planned > 0 && <span>{planned} planned</span>}
        {awayAllWeek ? (
          <span>Away this week</span>
        ) : (
          done === 0 && planned === 0 && <span>Nothing ticked yet</span>
        )}
        {met && <span style={{ color: habit.color }}>Goal met</span>}
      </div>
    </button>
  );
}

/** "19 Sep" */
function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
