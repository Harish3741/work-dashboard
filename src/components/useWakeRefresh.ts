"use client";

import { useEffect, useRef } from "react";
import { decideWakeRefresh, type WakeMark } from "@/lib/wake";
import { todayYmd } from "@/lib/time";

/**
 * Refetch the page's data when the laptop comes back, or when the date rolls
 * over under an open lid.
 *
 * The listeners cover the ordinary cases — switching back to the window, coming
 * back online, a bfcache restore. The ticker covers the one that actually bites:
 * the window is already frontmost when the lid closes, so on opening it there is
 * no focus change and no visibility change, and only the gap in the ticker says
 * anything happened. It is a clock check, not a poll — it fetches nothing while
 * the machine is simply awake.
 *
 * This asks for a plain refetch. Everything the header's Refresh posts is on a
 * server timer that catches up on wake by itself; firing those from here as well
 * would race the server's own passes.
 */

/** Short enough that the board is right again a moment after the lid opens. */
const TICK_MS = 2_000;

export default function useWakeRefresh(options: {
  onWake: () => void;
  /** True while a drag is in flight — the refetch waits rather than interrupt it. */
  isBusy: () => boolean;
  todayOnScreen: () => string;
}) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const mark: WakeMark = { wall: Date.now(), mono: performance.now() };
    let lastRefreshAt = Date.now();
    let deferred = false;

    const consider = (forced: boolean) => {
      const now: WakeMark = { wall: Date.now(), mono: performance.now() };
      const decision = decideWakeRefresh({
        mark: { ...mark },
        now,
        todayOnScreen: latest.current.todayOnScreen(),
        todayNow: todayYmd(),
        lastRefreshAt,
        forced,
        busy: latest.current.isBusy(),
      });
      mark.wall = decision.mark.wall;
      mark.mono = decision.mark.mono;
      if (decision.defer) deferred = true;
      if (!decision.refresh) return;
      deferred = false;
      lastRefreshAt = now.wall;
      latest.current.onWake();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") consider(false);
    };
    const onFocus = () => consider(false);
    const onOnline = () => consider(true);
    const onPageShow = (event: PageTransitionEvent) => consider(event.persisted);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);

    const timer = setInterval(() => {
      // A hidden tab is throttled anyway, and visibilitychange will ask again
      // the moment it is looked at; fetching now would be for nobody.
      if (document.visibilityState !== "visible") return;
      if (deferred && !latest.current.isBusy()) consider(true);
      else consider(false);
    }, TICK_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
      clearInterval(timer);
    };
  }, []);
}
