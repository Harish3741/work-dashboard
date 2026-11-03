"use client";

import { useState } from "react";
import Modal, { Field, GhostButton, PrimaryButton, inputClass } from "./Modal";
import { formatMinutes, parseTimeInput, toTimeInput } from "@/lib/time";
import type { CalendarRecord, Occurrence } from "@/lib/types";

export type EventDialogTarget =
  | { mode: "create"; ymd: string; startMin?: number }
  | { mode: "edit"; occurrence: Occurrence };

type Props = {
  target: EventDialogTarget;
  calendars: CalendarRecord[];
  onClose: () => void;
  onSaved: () => void;
};

export default function EventDialog({ target, calendars, onClose, onSaved }: Props) {
  const existing = target.mode === "edit" ? target.occurrence : null;
  const readOnly = existing?.origin === "ics";

  const [title, setTitle] = useState(existing?.title ?? "");
  const [calendarId, setCalendarId] = useState(existing?.calendarId ?? calendars[0]?.id ?? "");
  const [ymd, setYmd] = useState(existing?.ymd ?? (target.mode === "create" ? target.ymd : ""));
  const [allDay, setAllDay] = useState(
    existing ? existing.allDay : target.mode === "create" && target.startMin === undefined,
  );
  const [start, setStart] = useState(
    toTimeInput(existing?.startMin ?? (target.mode === "create" ? (target.startMin ?? 540) : 540)),
  );
  const [end, setEnd] = useState(
    toTimeInput(
      existing?.endMin ??
        (target.mode === "create" ? (target.startMin ?? 540) + 60 : 600),
    ),
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim()) return setError("Give the event a title");
    setBusy(true);
    setError(null);

    const payload = {
      title,
      ymd,
      calendarId: calendarId || null,
      allDay,
      startMin: allDay ? null : parseTimeInput(start),
      endMin: allDay ? null : parseTimeInput(end),
      endYmd: ymd,
      notes: notes.trim() || null,
    };

    const res = existing
      ? await fetch("/api/events", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, key: existing.key }),
        })
      : await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setError(body.error ?? "Could not save the event");
    }
    onSaved();
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    const res = await fetch(`/api/events?key=${encodeURIComponent(existing.key)}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setError(body.error ?? "Could not delete the event");
    }
    onSaved();
  }

  if (readOnly && existing) {
    const calendar = calendars.find((c) => c.id === existing.calendarId);
    return (
      <Modal title={existing.title} onClose={onClose} footer={<GhostButton onClick={onClose}>Close</GhostButton>}>
        <dl className="flex flex-col gap-2.5 text-[13px]">
          <Row label="When">
            {existing.ymd}
            {!existing.allDay && ` · ${formatMinutes(existing.startMin)}–${formatMinutes(existing.endMin)}`}
          </Row>
          {calendar && <Row label="Calendar">{calendar.name}</Row>}
          {existing.habitName && <Row label="Habit">{existing.habitName}</Row>}
          {existing.notes && <Row label="Notes">{existing.notes}</Row>}
        </dl>
        <p className="mt-4 rounded-lg bg-white/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
          This event comes from a calendar feed and is read-only here — edit it in your calendar. Drag it to
          another day or time to make an editable local copy (the original is unchanged).
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title={existing ? "Edit event" : "New event"}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <GhostButton danger onClick={remove} disabled={busy}>
              Delete
            </GhostButton>
          )}
          <div className="flex-1" />
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={save} disabled={busy}>
            {existing ? "Save" : "Add event"}
          </PrimaryButton>
        </>
      }
    >
      <Field label="Title">
        <input
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Gym"
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </Field>

      <Field label="Calendar">
        <select className={inputClass} value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
          <option value="">No calendar</option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Date">
        <input type="date" className={inputClass} value={ymd} onChange={(e) => setYmd(e.target.value)} />
      </Field>

      <label className="mb-3 flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        All-day
      </label>

      {!allDay && (
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Start">
              <input type="time" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="End">
              <input type="time" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      <Field label="Notes">
        <textarea
          className={`${inputClass} min-h-[64px] resize-y`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
        {existing?.detachedFromKey
          ? "This is a moved copy of a calendar-feed event, so it stays in this app — the original is unchanged."
          : "Saved events live in this app only; nothing is written back to your calendars."}{" "}
        To have this count toward a habit, give it the same title as that habit&apos;s match rule.
      </p>

      {error && <p className="mt-2 text-[12px] text-[#e05a5a]">{error}</p>}
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-[var(--text-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[var(--text)]">{children}</dd>
    </div>
  );
}
