"use client";

import { useEffect, useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import EventCard from "./EventCard";
import { DAY_LABELS, dayNumber, formatMinutes } from "@/lib/time";
import type { CalendarRecord, Occurrence } from "@/lib/types";

const HOUR_HEIGHT = 58;
const SLOT_MINUTES = 30;

type Props = {
  days: string[];
  today: string;
  byDay: Map<string, Occurrence[]>;
  calendarsById: Map<string, CalendarRecord>;
  onToggle: (occurrence: Occurrence, completed: boolean) => void;
  onOpen: (occurrence: Occurrence) => void;
  onAdd: (ymd: string, startMin?: number) => void;
};

/**
 * Time-grid week view. Unlike the month grid, dropping here sets the start
 * time as well as the day — each half-hour is its own drop target.
 */
export default function WeekGrid({
  days,
  today,
  byDay,
  calendarsById,
  onToggle,
  onOpen,
  onAdd,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to just before the week's earliest timed event, so nothing starts
  // out of view (falling back to 7am on an empty week).
  const earliestMin = days
    .flatMap((ymd) => byDay.get(ymd) ?? [])
    .filter((o) => !o.allDay && o.startMin !== null)
    .reduce<number | null>((min, o) => (min === null || o.startMin! < min ? o.startMin! : min), null);

  useEffect(() => {
    if (!scrollRef.current) return;
    const target = earliestMin === null ? 7 * 60 : Math.max(0, earliestMin - 30);
    scrollRef.current.scrollTop = (target / 60) * HOUR_HEIGHT;
  }, [earliestMin]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid border-b border-[var(--border)]" style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
        <div />
        {days.map((ymd, i) => (
          <div key={ymd} className="flex items-center justify-center gap-1.5 py-2">
            <span className="text-[13px] text-[var(--text-muted)]">{DAY_LABELS[i]}</span>
            <span
              className={`grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[13px] font-medium tabular-nums
                ${ymd === today ? "bg-[var(--accent)] text-white" : "text-[var(--text)]"}`}
            >
              {dayNumber(ymd)}
            </span>
          </div>
        ))}
      </div>

      {/* All-day row, above the scrolling time grid. */}
      <div
        className="grid border-b border-[var(--border)]"
        style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}
      >
        <div className="px-2 py-1 text-right text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
          All-day
        </div>
        {days.map((ymd) => (
          <AllDayCell key={ymd} ymd={ymd}>
            {(byDay.get(ymd) ?? [])
              .filter((o) => o.allDay)
              .map((occurrence) => (
                <EventCard
                  key={occurrence.key}
                  occurrence={occurrence}
                  calendar={occurrence.calendarId ? calendarsById.get(occurrence.calendarId) : undefined}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  compact
                />
              ))}
          </AllDayCell>
        ))}
      </div>

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
          <div>
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                className="relative pr-2 text-right text-[11px] text-[var(--text-faint)]"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="absolute right-2 -top-1.5">
                  {hour === 0 ? "" : formatMinutes(hour * 60)}
                </span>
              </div>
            ))}
          </div>

          {days.map((ymd) => (
            <DayColumn
              key={ymd}
              ymd={ymd}
              occurrences={(byDay.get(ymd) ?? []).filter((o) => !o.allDay)}
              calendarsById={calendarsById}
              onToggle={onToggle}
              onOpen={onOpen}
              onAdd={onAdd}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  ymd,
  occurrences,
  calendarsById,
  onToggle,
  onOpen,
  onAdd,
}: {
  ymd: string;
  occurrences: Occurrence[];
  calendarsById: Map<string, CalendarRecord>;
  onToggle: (occurrence: Occurrence, completed: boolean) => void;
  onOpen: (occurrence: Occurrence) => void;
  onAdd: (ymd: string, startMin?: number) => void;
}) {
  const slots = (24 * 60) / SLOT_MINUTES;

  return (
    <div className="relative border-l border-[var(--border)]">
      {Array.from({ length: slots }, (_, i) => (
        <Slot key={i} ymd={ymd} startMin={i * SLOT_MINUTES} onAdd={onAdd} />
      ))}

      <div className="pointer-events-none absolute inset-0">
        {occurrences.map((occurrence) => {
          const start = occurrence.startMin ?? 0;
          const end = occurrence.endMin ?? start + 60;
          const height = Math.max(26, ((end - start) / 60) * HOUR_HEIGHT - 2);
          // A block shorter than ~45 minutes has no room for the time line.
          const compact = height < 44;
          return (
            <div
              key={occurrence.key}
              className="pointer-events-auto absolute inset-x-1"
              style={{ top: (start / 60) * HOUR_HEIGHT, height }}
            >
              <EventCard
                occurrence={occurrence}
                calendar={occurrence.calendarId ? calendarsById.get(occurrence.calendarId) : undefined}
                onToggle={onToggle}
                onOpen={onOpen}
                compact={compact}
                fill
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Slot({
  ymd,
  startMin,
  onAdd,
}: {
  ymd: string;
  startMin: number;
  onAdd: (ymd: string, startMin?: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${ymd}@${startMin}` });
  const onHour = startMin % 60 === 0;

  return (
    <div
      ref={setNodeRef}
      onClick={() => onAdd(ymd, startMin)}
      className={`${onHour ? "border-t border-[var(--border)]" : "border-t border-transparent"}
        ${isOver ? "bg-white/[0.08]" : "hover:bg-white/[0.03]"}`}
      style={{ height: (HOUR_HEIGHT * SLOT_MINUTES) / 60 }}
    />
  );
}

/**
 * The all-day row is a drop target in its own right. Without one, a drop aimed
 * at it fell through to whichever half-hour slot happened to overlap — and
 * those slots scroll, so the winner was usually somewhere off-screen in the
 * early morning, silently retiming the event to a time nobody chose.
 *
 * Dropping here means "this day, same time", exactly as a month cell does.
 * It never converts a timed event to all-day: there is no write path to the calendar
 * for that, and the board's own time editor refuses it for the same reason.
 */
function AllDayCell({ ymd, children }: { ymd: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${ymd}@allday` });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-8 border-l border-[var(--border)] p-1 ${isOver ? "bg-white/[0.08]" : ""}`}
    >
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
