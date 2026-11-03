"use client";

import { useEffect, useRef } from "react";

/**
 * Refetch when the server says something changed that this page did not do.
 *
 * An edit made elsewhere (another tab, a script calling the API) would
 * otherwise sit invisible on an open board until the next refresh. The server
 * keeps a change counter (lib/changes, fed by the database); this asks for it
 * every few seconds while the page is visible and refetches when it moves. The
 * first answer only sets the mark. A drag in flight defers the refetch to the
 * next tick rather than moving rows under the pointer, as the wake refresh does.
 */

const POLL_MS = 5_000;

export default function useChangeRefresh(options: { onChange: () => void; isBusy: () => boolean }) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let seen: number | null = null;
    let pending = false;
    let stopped = false;

    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      let version: number;
      try {
        const res = await fetch("/api/changes", { cache: "no-store" });
        if (!res.ok) return;
        version = (await res.json()).version;
      } catch {
        return; // server restarting; the next poll asks again
      }
      if (stopped || typeof version !== "number") return;
      if (seen === null) {
        seen = version;
        return;
      }
      if (version !== seen) pending = true;
      seen = version;
      if (pending && !latest.current.isBusy()) {
        pending = false;
        latest.current.onChange();
      }
    };

    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
}
