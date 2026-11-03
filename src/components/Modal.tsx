"use client";

import { useEffect, useRef } from "react";

export const SWATCHES = [
  "#e8674a",
  "#e0a33e",
  "#4ec98a",
  "#3fb8c4",
  "#5b8def",
  "#a970e0",
  "#e05a8a",
  "#8d8d8d",
];

export default function Modal({
  title,
  heading,
  onClose,
  children,
  footer,
  wide,
  placement = "center",
  initialFocus = "first",
}: {
  /** Names the dialog (aria-label), and is its heading unless `heading` is given. */
  title: string;
  /** Drawn in place of the plain heading — the details panel's editable title. */
  heading?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** For a panel written into rather than filled in — the notes editor. */
  wide?: boolean;
  /**
   * "top" pins the dialog's top edge instead of centring it. A centred dialog
   * whose height changes moves its top — the notes panel jumped on every save
   * as its footer came and went, and half a row up for every row a note grew.
   */
  placement?: "center" | "top";
  /**
   * "panel" focuses the dialog itself on open, for content that places the
   * caret once it has loaded. Focusing the first control put focus on Close
   * while the note loaded, where Space or Enter would press it.
   */
  initialFocus?: "first" | "panel";
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A field inside used Escape itself (reverting an edit) and said so.
      // Works because React's listener runs before this one — its root is
      // `document` and was added first — so keep this bubble-phase. A field's
      // stopPropagation would NOT reach it: both listeners are on the same node.
      if (e.defaultPrevented) return;
      // Escape while composing cancels the composition, not the dialog.
      if (e.isComposing || e.keyCode === 229) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Separate, and on mount only. Bundled in above it re-ran whenever `onClose`
  // changed identity — which for a dialog whose parent re-renders as you type
  // is every keystroke — and stole focus back to the first control each time.
  // A field marked data-no-autofocus (the panel title) is skipped, so opening
  // a panel never drops you into renaming it.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (initialFocus === "panel") {
      panel.focus();
      return;
    }
    panel
      .querySelector<HTMLElement>(
        "input:not([data-no-autofocus]), select, textarea:not([data-no-autofocus]), button",
      )
      ?.focus();
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 grid bg-black/50 p-4 ${
        placement === "top" ? "items-start justify-items-center pt-[7.5vh]" : "place-items-center"
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={initialFocus === "panel" ? -1 : undefined}
        // Inline, not Tailwind's outline-none: globals.css rings *:focus-visible
        // unlayered, and an unlayered rule beats every layered utility. Focus
        // only rests on the panel until the content takes it.
        style={initialFocus === "panel" ? { outline: "none" } : undefined}
        className={`pop-in flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl
          border border-[var(--border)] bg-[var(--surface)] shadow-2xl ${
            wide ? "max-w-[560px]" : "max-w-[420px]"
          }`}
      >
        <header
          className={`flex ${heading ? "items-start gap-2" : "items-center"} justify-between border-b
            border-[var(--border)] px-4 py-3`}
        >
          {heading ?? <h2 className="text-[14px] font-semibold">{title}</h2>}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-md text-[var(--text-muted)]
              transition-colors hover:bg-white/[0.06] hover:text-[var(--text)]"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div data-modal-body className="scroll-thin flex-1 overflow-y-auto px-4 py-3.5">
          {children}
        </div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-[13px] " +
  "text-[var(--text)] placeholder:text-[var(--text-faint)]";

export function Swatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Colour ${color}`}
          onClick={() => onChange(color)}
          className={`size-6 rounded-full transition-transform ${
            value === color ? "ring-2 ring-white ring-offset-2 ring-offset-[var(--surface)]" : ""
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

export function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[13px] font-medium text-white
        transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      className={`rounded-lg px-3 py-1.5 text-[13px] transition-colors hover:bg-white/[0.06] ${
        danger ? "text-[#e05a5a]" : "text-[var(--text-muted)]"
      }`}
    >
      {children}
    </button>
  );
}
