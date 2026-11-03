"use client";

import { useState } from "react";
import Modal, { Field, GhostButton, PrimaryButton, Swatches, inputClass } from "./Modal";
import type { CalendarRecord, SyncStatus } from "@/lib/types";

type Props = {
  calendars: CalendarRecord[];
  sync: SyncStatus[];
  onClose: () => void;
  onChanged: () => void;
};

export default function CalendarsDialog({ calendars, sync, onClose, onChanged }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState("#5b8def");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim() || !url.trim()) return setError("Both a name and a URL are needed");
    setBusy(true);
    setError(null);
    const res = await fetch("/api/calendars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url, color }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setError(body.error ?? "Could not add the calendar");
    }
    setName("");
    setUrl("");
    onChanged();
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/calendars?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(false);
    onChanged();
  }

  async function recolour(id: string, next: string) {
    await fetch("/api/calendars", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, color: next }),
    });
    onChanged();
  }

  return (
    <Modal title="Calendars" onClose={onClose} footer={<GhostButton onClick={onClose}>Done</GhostButton>}>
      <div className="mb-4 flex flex-col gap-2">
        {calendars.map((calendar) => {
          const status = sync.find((s) => s.calendarId === calendar.id);
          return (
            <div key={calendar.id} className="rounded-lg bg-white/[0.04] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${calendar.name} colour`}
                  value={calendar.color}
                  onChange={(e) => recolour(calendar.id, e.target.value)}
                  className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{calendar.name}</span>
                <GhostButton danger onClick={() => remove(calendar.id)} disabled={busy}>
                  Remove
                </GhostButton>
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-faint)]">
                {status?.lastStatus === "error" ? (
                  <span className="text-[#e05a5a]">Sync failed: {status.lastError}</span>
                ) : status?.lastStatus === "ok" ? (
                  `${status.eventCount} events cached`
                ) : (
                  "Not synced yet"
                )}
              </p>
            </div>
          );
        })}
        {calendars.length === 0 && (
          <p className="text-[12px] text-[var(--text-faint)]">No calendars configured yet.</p>
        )}
      </div>

      <div className="border-t border-[var(--border)] pt-3.5">
        <h3 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Add a calendar
        </h3>
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" />
        </Field>
        <Field label="Published URL">
          <input
            className={inputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or webcal://… (.ics feed)"
          />
        </Field>
        <Field label="Colour">
          <Swatches value={color} onChange={setColor} />
        </Field>
        <PrimaryButton onClick={add} disabled={busy}>
          Add calendar
        </PrimaryButton>
        {error && <p className="mt-2 text-[12px] text-[#e05a5a]">{error}</p>}

        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-faint)]">
          In Calendar on macOS: right-click a calendar → Share Calendar → tick Public Calendar, then
          copy the link. Anyone with that link can read the calendar, so keep it private. Access is
          read-only — this app never writes back to your calendars.
        </p>
      </div>
    </Modal>
  );
}
