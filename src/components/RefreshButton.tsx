"use client";

/**
 * The one manual refresh (see useAppState.runSync). The calendar feeds also
 * refresh on their own every hour, so this is for "I just changed my
 * calendar", not upkeep.
 */
export default function RefreshButton({
  syncing,
  error,
  onClick,
}: {
  syncing: boolean;
  error: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={syncing}
      title={error ?? "Refresh calendars"}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] transition-colors
        disabled:opacity-50 ${
          error
            ? "bg-[#3a2020] text-[#e08a8a] hover:bg-[#4a2626]"
            : "bg-[var(--card)] text-[var(--text)] hover:bg-[var(--card-hover)]"
        }`}
    >
      <svg
        viewBox="0 0 16 16"
        className={`size-3.5 ${syncing ? "animate-spin" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13 2v3h-3" />
      </svg>
      {syncing ? "Refreshing…" : error ? "Refresh failed" : "Refresh"}
    </button>
  );
}
