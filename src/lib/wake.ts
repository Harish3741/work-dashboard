/**
 * When a page that has been sitting open needs its data again.
 *
 * The app is left open for days in a window that is usually already frontmost,
 * so closing and opening the lid produces no focus change and often no
 * visibility change either — nothing tells the page that eight hours went past.
 * Two signals stand in for that:
 *
 *   the clock jumped   the caller marks the time every couple of seconds, so a
 *                      gap between marks means nothing was running in between —
 *                      the computer was asleep, or the tab was frozen
 *   the date changed   the lid stayed open past midnight, which leaves the board
 *                      showing yesterday's three rows with yesterday highlighted
 *
 * Kept here rather than in the hook so it is covered by `npm test`; the hook is
 * only listeners and a timer.
 */

/** A moment read from both clocks: one jumps across sleep, the other does not. */
export type WakeMark = { wall: number; mono: number };

/**
 * A gap this long between marks means the page was not running. Comfortably
 * above the once-a-minute a browser throttles a hidden tab to, so an ordinary
 * background tab is not mistaken for a wake.
 */
export const WAKE_GAP_MS = 90_000;

/** visibilitychange, focus and online all fire together on wake; refetch once. */
export const WAKE_MIN_INTERVAL_MS = 5_000;

export type WakeInput = {
  /** The previous mark, from the last time this was called. */
  mark: WakeMark;
  now: WakeMark;
  /** The date the page is currently rendering. */
  todayOnScreen: string;
  /** The date it actually is. */
  todayNow: string;
  lastRefreshAt: number;
  /** The trigger was explicit (came back online, restored from bfcache). */
  forced: boolean;
  /** Something the refetch would interrupt is in progress — a drag. */
  busy: boolean;
};

export type WakeDecision = {
  refresh: boolean;
  /** Wanted, but held: ask again once `busy` clears. */
  defer: boolean;
  mark: WakeMark;
};

export function decideWakeRefresh(input: WakeInput): WakeDecision {
  const { mark, now } = input;
  const wallGap = now.wall - mark.wall;
  // Either clock alone can be fooled — a frozen tab stops both, a clock
  // correction moves only one — so take a wake from whichever notices.
  const slept = wallGap > WAKE_GAP_MS || wallGap - (now.mono - mark.mono) > WAKE_GAP_MS;
  const rolled = input.todayNow !== input.todayOnScreen;

  const held: WakeDecision = { refresh: false, defer: false, mark: now };
  if (!(input.forced || slept || rolled)) return held;
  if (now.wall - input.lastRefreshAt < WAKE_MIN_INTERVAL_MS) return held;
  if (input.busy) return { ...held, defer: true };
  return { ...held, refresh: true };
}
