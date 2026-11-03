"use client";

import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import MonthEventRow from "./MonthEventRow";
import { DAY_LABELS, dayNumber, isSameMonth } from "@/lib/time";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
import type { CalendarRecord, Occurrence } from "@/lib/types";

type Props = {
  days: string[];
  anchor: string;
  today: string;
  byDay: Map<string, Occurrence[]>;
  calendarsById: Map<string, CalendarRecord>;
  onToggle: (occurrence: Occurrence, completed: boolean) => void;
  onOpen: (occurrence: Occurrence) => void;
  onAdd: (ymd: string) => void;
};

export default function MonthGrid({
  days,
  anchor,
  today,
  byDay,
  calendarsById,
  onToggle,
  onOpen,
  onAdd,
}: Props) {
  const weeks = Math.ceil(days.length / 7);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-[var(--border)]">
        {DAY_LABELS.map((label, i) => (
          <div
            key={label}
            className={`px-2 py-1.5 text-right text-[12px] ${i >= 5 ? "text-[var(--text-faint)]" : "text-[var(--text-muted)]"}`}
          >
            {label}
          </div>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}
      >
        {days.map((ymd, i) => (
          <DayCell
            key={ymd}
            ymd={ymd}
            weekend={i % 7 >= 5}
            inMonth={isSameMonth(ymd, anchor)}
            isToday={ymd === today}
            occurrences={byDay.get(ymd) ?? []}
            calendarsById={calendarsById}
            onToggle={onToggle}
            onOpen={onOpen}
            onAdd={onAdd}
          />
        ))}
      </div>
    </div>
  );
}

function DayCell({
  ymd,
  weekend,
  inMonth,
  isToday,
  occurrences,
  calendarsById,
  onToggle,
  onOpen,
  onAdd,
}: {
  ymd: string;
  weekend: boolean;
  inMonth: boolean;
  isToday: boolean;
  occurrences: Occurrence[];
  calendarsById: Map<string, CalendarRecord>;
  onToggle: (occurrence: Occurrence, completed: boolean) => void;
  onOpen: (occurrence: Occurrence) => void;
  onAdd: (ymd: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ymd });
  const listRef = useRef<HTMLDivElement>(null);
  const hidden = useHiddenCount(listRef, occurrences.length);

  return (
    <div
      ref={setNodeRef}
      className={`day-cell relative flex min-h-0 flex-col border-b border-r border-[var(--border)] transition-colors
        ${isOver ? "bg-white/[0.06]" : weekend ? "bg-[var(--weekend)]" : ""}`}
    >
      <div className="flex items-center justify-between px-1 pt-1">
        <button
          type="button"
          onClick={() => onAdd(ymd)}
          aria-label={`Add event on ${ymd}`}
          className="day-add grid size-5 place-items-center rounded-md text-[var(--text-muted)]
            transition-colors hover:bg-[var(--card)] hover:text-[var(--text)]"
        >
          <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
            <path
              d="M8 3.5v9M3.5 8h9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <span
          className={`grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[13px] tabular-nums
            ${isToday ? "bg-[var(--accent)] font-semibold text-white" : inMonth ? "text-[var(--text)]" : "text-[var(--text-faint)]"}`}
        >
          {/* Like Calendar.app, the 1st carries its month name. */}
          {dayNumber(ymd) === 1 && !isToday ? `${MONTH_SHORT[Number(ymd.slice(5, 7)) - 1]} 1` : dayNumber(ymd)}
        </span>
      </div>

      <div
        ref={listRef}
        className={`scroll-thin relative flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1 pb-1 pt-0.5
          ${inMonth ? "" : "opacity-45"}`}
      >
        {occurrences.map((occurrence) => (
          <MonthEventRow
            key={occurrence.key}
            occurrence={occurrence}
            calendar={
              occurrence.calendarId ? calendarsById.get(occurrence.calendarId) : undefined
            }
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => listRef.current?.scrollBy({ top: 120, behavior: "smooth" })}
          className={`absolute inset-x-1 bottom-0 bg-gradient-to-t pb-0.5 pl-1 pt-2 text-left text-[11px]
            text-[var(--text-faint)] transition-colors hover:text-[var(--text-muted)]
            ${weekend ? "from-[var(--weekend)] via-[var(--weekend)]" : "from-[var(--bg)] via-[var(--bg)]"} to-transparent`}
        >
          {hidden} more
        </button>
      )}
    </div>
  );
}

/**
 * How many event cards are scrolled out of view. Day cells are short, so
 * without this an event can be silently invisible — the count makes the
 * overflow explicit and gives somewhere to click.
 */
function useHiddenCount(ref: React.RefObject<HTMLDivElement | null>, total: number): number {
  const [hidden, setHidden] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Layout metrics, deliberately not getBoundingClientRect: cards run a
    // translate/scale entry animation, and rects include transforms, so a card
    // measured mid-animation reads as overflowing when it actually fits. The
    // list is `relative` so it is the offsetParent — otherwise offsetTop would
    // resolve against the day cell and include the day-number header.
    const measure = () => {
      const limit = node.clientHeight + node.scrollTop;
      let visible = 0;
      for (const child of Array.from(node.children) as HTMLElement[]) {
        if (child.offsetTop + child.offsetHeight <= limit + 1) visible += 1;
      }
      setHidden(Math.max(0, total - visible));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [ref, total]);

  return hidden;
}
