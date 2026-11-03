"use client";

import { useDraggable } from "@dnd-kit/core";
import { formatMinutes } from "@/lib/time";
import type { CalendarRecord, Occurrence } from "@/lib/types";

type Props = {
  occurrence: Occurrence;
  calendar: CalendarRecord | undefined;
  onToggle: (occurrence: Occurrence, completed: boolean) => void;
  onOpen: (occurrence: Occurrence) => void;
};

/**
 * One line in a month cell, drawn the way Calendar.app does it: a coloured dot,
 * the title, the time pushed right. All-day events sit on a tinted bar.
 * The week view keeps the full EventCard.
 *
 * The dot is the tick-box — every event stays tickable here, as it was with the
 * card (only habit matches move habit progress). A done event keeps full
 * strength (no fade, no strike-through); its dot turns
 * into a tick instead.
 */
export default function MonthEventRow({ occurrence, calendar, onToggle, onOpen }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: occurrence.key,
    data: { occurrence },
  });

  const accent = occurrence.habitColor ?? calendar?.color ?? "#6b6b6b";
  const done = occurrence.completed;

  const tick = (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`Mark ${occurrence.title} ${done ? "not done" : "done"}`}
      title={done ? "Mark not done" : "Mark done"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(occurrence, !done);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="grid size-3.5 shrink-0 place-items-center rounded-full"
    >
      {done ? (
        <svg viewBox="0 0 14 14" aria-hidden className="size-[11px]">
          <path
            d="M2.5 7.4l2.9 2.9L11.5 4"
            fill="none"
            stroke={accent}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span
          className="block size-[7px] rounded-full ring-offset-0 transition-shadow hover:ring-2"
          style={{ background: accent, ["--tw-ring-color" as string]: `${accent}66` }}
        />
      )}
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-label={`${occurrence.title}${occurrence.allDay ? ", all day" : `, ${formatMinutes(occurrence.startMin)}`}${done ? ", done" : ""}`}
      onClick={() => onOpen(occurrence)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(occurrence);
        }
      }}
      // shrink-0 for the same reason as EventCard: a compressed row would clip
      // itself instead of overflowing, which hides the "N more" count.
      className={`pop-in flex w-full shrink-0 items-center gap-1 rounded-[4px] text-left text-[11.5px] leading-[18px]
        transition-colors ${occurrence.allDay ? "pl-0.5 pr-1.5" : "pl-0.5 pr-1 hover:bg-white/[0.05]"}
        ${isDragging ? "dragging" : ""}`}
      style={occurrence.allDay ? { background: `${accent}2e`, color: accent } : undefined}
    >
      {tick}

      <span className={`min-w-0 flex-1 truncate ${occurrence.allDay ? "font-medium" : "text-[var(--text)]"}`}>
        {occurrence.title}
      </span>

      {occurrence.origin === "local" && (
        <span
          title={
            occurrence.detachedFromKey
              ? "Moved copy — the feed original is hidden and unchanged"
              : "Added here — stays in this app"
          }
          className="size-1 shrink-0 rounded-full bg-[var(--text-faint)]"
        />
      )}

      {!occurrence.allDay && (
        <span className="shrink-0 tabular-nums text-[var(--text-faint)]">
          {formatMinutes(occurrence.startMin).replace(" ", "")}
        </span>
      )}
    </div>
  );
}
