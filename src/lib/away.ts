import { addDays, endOfWeek } from "./time.js";

/**
 * Time away, the pure half: the record shape and the arithmetic the sidebar,
 * the board and the scorer share. No database here, so client components can
 * import it; the storage lives in ./pauses.ts.
 */

export type PauseRecord = {
  id: string;
  fromYmd: string;
  toYmd: string;
  label: string;
  /** board = typed on the board; inbox = a message; calendar = flight events. */
  source: "board" | "inbox" | "calendar";
  /** Awaiting the user's approval in From messages; does not count yet. */
  pending: boolean;
  createdAt: string;
  /** Calendar pauses only: the outbound flight's occurrence key. */
  originKey: string | null;
};

/** Days of the Monday-start week containing `weekStart` that fall in a pause. */
export function pausedDaysInWeek(pauses: PauseRecord[], weekStart: string): number {
  const end = endOfWeek(weekStart);
  const days = new Set<string>();
  for (const p of pauses) {
    if (p.pending) continue;
    if (p.toYmd < weekStart || p.fromYmd > end) continue;
    const from = p.fromYmd < weekStart ? weekStart : p.fromYmd;
    const to = p.toYmd > end ? end : p.toYmd;
    for (let d = from; d <= to; d = addDays(d, 1)) days.add(d);
  }
  return days.size;
}

export function isPaused(pauses: PauseRecord[], ymd: string): boolean {
  return pauses.some((p) => !p.pending && p.fromYmd <= ymd && ymd <= p.toYmd);
}

/**
 * The pause covering `ymd`, or the next one to start after it — what the
 * sidebar chip shows. Null when nothing is coming up.
 */
export function currentOrNextPause(pauses: PauseRecord[], ymd: string): PauseRecord | null {
  const active = pauses.filter((p) => !p.pending);
  const current = active.find((p) => p.fromYmd <= ymd && ymd <= p.toYmd);
  if (current) return current;
  const upcoming = active.filter((p) => p.fromYmd > ymd).sort((a, b) => (a.fromYmd < b.fromYmd ? -1 : 1));
  return upcoming[0] ?? null;
}
