"use client";

import { useEffect, useMemo, useState } from "react";
import Modal, { Field, GhostButton, PrimaryButton, Swatches, inputClass } from "./Modal";
import type { CalendarRecord, HabitRecord, MatchMode, TargetType } from "@/lib/types";

type Props = {
  habit: HabitRecord | null;
  calendars: CalendarRecord[];
  onClose: () => void;
  onSaved: () => void;
};

const TARGET_LABELS: Record<TargetType, string> = {
  times_per_week: "Times per week",
  days_per_week: "Days per week",
  every_day: "Every day",
};

export default function HabitDialog({ habit, calendars, onClose, onSaved }: Props) {
  const [name, setName] = useState(habit?.name ?? "");
  const [matchTitle, setMatchTitle] = useState(habit?.matchTitle ?? "");
  const [matchMode, setMatchMode] = useState<MatchMode>(habit?.matchMode ?? "exact");
  const [calendarId, setCalendarId] = useState(habit?.calendarId ?? "");
  const [targetType, setTargetType] = useState<TargetType>(habit?.targetType ?? "times_per_week");
  const [targetCount, setTargetCount] = useState(habit?.targetCount ?? 3);
  const [color, setColor] = useState(habit?.color ?? "#e8674a");
  const [titles, setTitles] = useState<{ title: string; count: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Titles actually present in the synced calendars, so a typed rule can be
  // checked against reality before it is saved.
  useEffect(() => {
    const query = calendarId ? `&calendarId=${encodeURIComponent(calendarId)}` : "";
    fetch(`/api/habits?suggestions${query}`)
      .then((r) => r.json())
      .then((d) => setTitles(d.titles ?? []))
      .catch(() => setTitles([]));
  }, [calendarId]);

  const effectiveMatch = (matchTitle.trim() || name.trim()).toLowerCase();
  const matches = useMemo(() => {
    if (!effectiveMatch) return [];
    return titles.filter((t) => {
      const candidate = t.title.trim().toLowerCase();
      return matchMode === "contains" ? candidate.includes(effectiveMatch) : candidate === effectiveMatch;
    });
  }, [titles, effectiveMatch, matchMode]);

  const matchedEvents = matches.reduce((sum, t) => sum + t.count, 0);

  async function save() {
    if (!name.trim()) return setError("Give the habit a name");
    setBusy(true);
    setError(null);

    const payload = {
      id: habit?.id,
      name,
      matchTitle: matchTitle.trim() || name,
      matchMode,
      calendarId: calendarId || null,
      targetType,
      targetCount,
      color,
      metricKind: null,
      metricThreshold: null,
    };

    const res = await fetch("/api/habits", {
      method: habit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setError(body.error ?? "Could not save the habit");
    }
    onSaved();
  }

  async function remove() {
    if (!habit) return;
    setBusy(true);
    await fetch(`/api/habits?id=${encodeURIComponent(habit.id)}`, { method: "DELETE" });
    setBusy(false);
    onSaved();
  }

  return (
    <Modal
      title={habit ? "Edit habit" : "New habit"}
      onClose={onClose}
      footer={
        <>
          {habit && (
            <GhostButton danger onClick={remove} disabled={busy}>
              Delete
            </GhostButton>
          )}
          <div className="flex-1" />
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={save} disabled={busy}>
            {habit ? "Save" : "Add habit"}
          </PrimaryButton>
        </>
      }
    >
      <Field label="Habit name">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Gym"
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </Field>

      <Field label="Calendar">
        <select className={inputClass} value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
          <option value="">Any calendar</option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Matches events titled">
        {/* Grid rather than flex: both controls carry w-full from inputClass,
            which collapses the text field inside a flex row. */}
        <div className="grid grid-cols-[1fr_112px] gap-2">
          <input
            className={inputClass}
            value={matchTitle}
            onChange={(e) => setMatchTitle(e.target.value)}
            placeholder={name || "Gym"}
          />
          <select
            className={inputClass}
            value={matchMode}
            onChange={(e) => setMatchMode(e.target.value as MatchMode)}
          >
            <option value="exact">exactly</option>
            <option value="contains">contains</option>
          </select>
        </div>
      </Field>

      <div className="mb-3 rounded-lg bg-white/[0.04] px-3 py-2.5 text-[12px] leading-relaxed">
        {!effectiveMatch ? (
          <span className="text-[var(--text-faint)]">Type a name to check what it matches.</span>
        ) : matchedEvents > 0 ? (
          <span className="text-[var(--text-muted)]">
            Matches <strong className="text-[var(--text)]">{matchedEvents}</strong> synced event
            {matchedEvents === 1 ? "" : "s"}
            {matches.length > 1 && ` across ${matches.length} titles`}
            {matches.length > 0 && (
              <span className="text-[var(--text-faint)]">
                {" "}
                — {matches.slice(0, 3).map((m) => `"${m.title}"`).join(", ")}
                {matches.length > 3 ? "…" : ""}
              </span>
            )}
          </span>
        ) : (
          <span className="text-[#d9a441]">
            No synced events match this yet. Check the spelling against your calendar, or switch to
            “contains”.
          </span>
        )}
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <Field label="Goal">
            <select
              className={inputClass}
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as TargetType)}
            >
              {(Object.keys(TARGET_LABELS) as TargetType[]).map((key) => (
                <option key={key} value={key}>
                  {TARGET_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {targetType !== "every_day" && (
          <div className="w-[92px] shrink-0">
            <Field label="Target">
              <input
                type="number"
                min={1}
                max={targetType === "days_per_week" ? 7 : 21}
                className={inputClass}
                value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value))}
              />
            </Field>
          </div>
        )}
      </div>

      <Field label="Colour">
        <Swatches value={color} onChange={setColor} />
      </Field>

      <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
        Progress comes only from ticking matching events on the calendar. “Times per week” counts
        every ticked event; “days per week” counts distinct days.
      </p>

      {error && <p className="mt-2 text-[12px] text-[#e05a5a]">{error}</p>}
    </Modal>
  );
}
