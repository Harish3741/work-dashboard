"use client";

import { useMemo, useRef, useState } from "react";
import type { ContactRecord } from "@/lib/contacts";

const COLUMNS = [
  { key: "name", label: "Name", width: "minmax(11rem,1.4fr)" },
  { key: "role", label: "Role", width: "minmax(12rem,2fr)" },
  { key: "org", label: "Organisation", width: "minmax(10rem,1.3fr)" },
  { key: "email", label: "Email", width: "minmax(11rem,1.3fr)" },
  { key: "phone", label: "Phone", width: "minmax(8rem,0.8fr)" },
  { key: "event", label: "Event", width: "minmax(8rem,0.8fr)" },
  { key: "category", label: "Category", width: "minmax(8rem,0.9fr)" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

const GRID = COLUMNS.map((c) => c.width).join(" ") + " 1.5rem";

export default function ContactsTab({
  contacts,
  onChanged,
}: {
  contacts: ContactRecord[];
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [event, setEvent] = useState("");
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);

  const events = useMemo(
    () => [...new Set(contacts.map((c) => c.event).filter((e): e is string => !!e))].sort(),
    [contacts],
  );
  const categories = useMemo(
    () => [...new Set(contacts.map((c) => c.category).filter((c): c is string => !!c))].sort(),
    [contacts],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (event && c.event !== event) return false;
      if (category && c.category !== category) return false;
      if (!needle) return true;
      return COLUMNS.some((col) => (c[col.key] ?? "").toLowerCase().includes(needle));
    });
  }, [contacts, query, event, category]);

  async function add() {
    setAdding(true);
    await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New contact", event: event || undefined }),
    });
    setAdding(false);
    onChanged();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
      <div className="flex flex-wrap items-center gap-2 pb-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search contacts"
          className="w-56 rounded-lg bg-[var(--card)] px-2.5 py-1.5 text-[12px] text-[var(--text)]
            placeholder:text-[var(--text-faint)]"
        />
        <Select value={event} onChange={setEvent} all="All events" options={events} label="Filter by event" />
        <Select
          value={category}
          onChange={setCategory}
          all="All categories"
          options={categories}
          label="Filter by category"
        />

        <span className="text-[11px] tabular-nums text-[var(--text-faint)]">
          {shown.length}
          {shown.length === contacts.length ? "" : ` of ${contacts.length}`}
        </span>

        <div className="flex-1" />

        <button
          type="button"
          onClick={add}
          disabled={adding}
          className="rounded-lg bg-[var(--card)] px-3 py-1.5 text-[12px] text-[var(--text)]
            transition-colors hover:bg-[var(--card-hover)] disabled:opacity-50"
        >
          + Add
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-[var(--border)] scroll-thin">
        <div
          className="sticky top-0 z-10 grid items-center gap-x-3 border-b border-[var(--border)]
            bg-[var(--surface)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide
            text-[var(--text-muted)]"
          style={{ gridTemplateColumns: GRID }}
        >
          {COLUMNS.map((column) => (
            <span key={column.key}>{column.label}</span>
          ))}
          <span />
        </div>

        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-[var(--text-faint)]">
            {contacts.length === 0 ? "No contacts yet." : "Nothing matches that."}
          </p>
        ) : (
          shown.map((contact) => (
            <ContactRow key={contact.id} contact={contact} onChanged={onChanged} />
          ))
        )}
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  all,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  all: string;
  options: string[];
  label: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="rounded-lg bg-[var(--card)] px-2.5 py-1.5 text-[12px] text-[var(--text)]"
    >
      <option value="">{all}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function ContactRow({
  contact,
  onChanged,
}: {
  contact: ContactRecord;
  onChanged: () => void;
}) {
  async function patch(key: ColumnKey, value: string) {
    if ((contact[key] ?? "") === value) return;
    if (key === "name" && !value.trim()) return;
    await fetch("/api/contacts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: contact.id, [key]: value }),
    });
    onChanged();
  }

  async function remove() {
    await fetch(`/api/contacts?id=${encodeURIComponent(contact.id)}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div
      className="group grid items-center gap-x-3 border-b border-[var(--border)] px-3
        hover:bg-white/[0.03]"
      style={{ gridTemplateColumns: GRID }}
    >
      {COLUMNS.map((column) => (
        <Cell
          key={column.key}
          value={contact[column.key] ?? ""}
          label={`${column.label} for ${contact.name}`}
          onCommit={(value) => patch(column.key, value)}
        />
      ))}

      <button
        type="button"
        onClick={remove}
        aria-label={`Delete ${contact.name}`}
        className="justify-self-end text-[var(--text-faint)] opacity-0 transition-opacity
          hover:text-[#e05a5a] group-hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Every cell is editable in place. It stays an input rather than swapping one
 * in on click, so tabbing across a row works the way a spreadsheet does — but
 * it is styled flat until focused, so the table still reads as a table.
 */
function Cell({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // Escape has to reach the blur that follows it, and a setState does not:
  // blur reads the draft from the render it was scheduled in, so resetting the
  // state and blurring saved the abandoned text instead of discarding it.
  const abandoned = useRef(false);

  // The row can be refetched under an unfocused cell (a sync landing, another
  // edit saving); take the server's value then, never while it is being typed in.
  if (!focused && draft !== value) setDraft(value);

  return (
    <input
      value={draft}
      aria-label={label}
      onFocus={() => {
        abandoned.current = false;
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (abandoned.current) {
          abandoned.current = false;
          setDraft(value);
          return;
        }
        onCommit(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          abandoned.current = true;
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 truncate rounded bg-transparent px-1 py-2 text-[12px] text-[var(--text)]
        placeholder:text-[var(--text-faint)] focus:bg-[var(--bg)]"
      placeholder="—"
    />
  );
}
