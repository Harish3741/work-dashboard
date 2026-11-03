"use client";

import { useDraggable } from "@dnd-kit/core";
import { formatMinutes } from "@/lib/time";
import type { CalendarRecord, Occurrence } from "@/lib/types";

type Props = {
  occurrence: Occurrence;
  calendar: CalendarRecord | undefined;
  onToggle: (occurrence: Occurrence, completed: boolean) => void;
  onOpen: (occurrence: Occurrence) => void;
  /** Drop the time line — for all-day chips and short week-view blocks. */
  compact?: boolean;
  /** Stretch to the container height — the week grid sizes blocks by duration. */
  fill?: boolean;
};

export default function EventCard({ occurrence, calendar, onToggle, onOpen, compact, fill }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: occurrence.key,
    data: { occurrence },
  });

  const accent = occurrence.habitColor ?? calendar?.color ?? "#6b6b6b";
  const showTime = !occurrence.allDay && !compact;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-label={`${occurrence.title}${occurrence.allDay ? ", all day" : `, ${formatMinutes(occurrence.startMin)}`}`}
      onClick={() => onOpen(occurrence)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(occurrence);
        }
      }}
      // shrink-0: as a flex child in the month cell the card would otherwise
      // compress to fit and clip its own text instead of overflowing, which
      // also hides the "+N more" affordance.
      className={`group pop-in w-full shrink-0 overflow-hidden rounded-lg bg-[var(--card)] px-2 py-1.5 text-left
        transition-colors hover:bg-[var(--card-hover)] ${fill ? "h-full" : ""} ${isDragging ? "dragging" : ""}`}
      style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
    >
      <div className="flex items-center gap-1.5">
        {/* Every event is tickable, not just habit-matching ones — the to-do
            board treats meetings as work items too. Only habit matches move
            habit progress. */}
        <input
          type="checkbox"
          aria-label={`Mark ${occurrence.title} done`}
          checked={occurrence.completed}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onToggle(occurrence, e.target.checked)}
          className="size-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-[#6a6a6a]
            transition-colors checked:border-transparent"
          style={
            occurrence.completed
              ? {
                  backgroundColor: accent,
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath fill='none' stroke='%23131313' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' d='M3 7.2l2.6 2.6L11 4.4'/%3E%3C/svg%3E\")",
                  backgroundSize: "100%",
                }
              : undefined
          }
        />

        <span
          className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight text-[var(--text)]"
        >
          {occurrence.title}
        </span>

        {occurrence.origin === "local" && (
          <span
            title={
              occurrence.detachedFromKey
                ? "Moved copy — the feed original is hidden and unchanged"
                : "Added here — stays in this app"
            }
            className="size-1.5 shrink-0 rounded-full bg-[var(--text-faint)]"
          />
        )}
      </div>

      {showTime && (
        <div className="mt-0.5 truncate pl-5 text-[11px] leading-tight text-[var(--text-muted)]">
          {formatMinutes(occurrence.startMin)}
        </div>
      )}
    </div>
  );
}
