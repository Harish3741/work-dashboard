/**
 * The app's change bus: "something the user can see just changed".
 *
 * Fed from the database itself (TEMP triggers on this process's connection,
 * see `installChangeHooks` in db.ts), so every writer is covered without any
 * of them having to remember to call it. The open page polls
 * `changeVersion()` through /api/changes and refetches when it moves, so an
 * edit made in another tab (or by a script hitting the API) shows up without a
 * Refresh.
 *
 * Dependency-free on purpose: db.ts imports it, and it must not import back.
 *
 * The state lives on globalThis, not in module scope. Next bundles
 * instrumentation (the scheduler) separately from the API routes, so this
 * module is loaded more than once per process; module-level state would give
 * each copy its own version.
 */

type Listener = (key: string) => void;

type Bus = {
  listeners: Set<Listener>;
  version: number;
};
const g = globalThis as typeof globalThis & { __habitChangeBus?: Bus };
const bus: Bus = (g.__habitChangeBus ??= {
  listeners: new Set<Listener>(),
  version: 0,
});
const { listeners } = bus;

/** Record a change to one item (or a pseudo-key such as "calendar"). */
export function noteChange(key: string): void {
  bus.version += 1;
  for (const listener of listeners) {
    try {
      listener(key);
    } catch {
      /* a listener's failure is its own business, never the writer's */
    }
  }
}

/** Subscribe to changes; returns the unsubscribe. Use it to hook in your own sync. */
export function onChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A number that moves whenever anything visible changed. Only ever compared
 * for equality by the client; it restarts at 0 with the server, which the
 * client reads as "changed" too, and a refetch is exactly right after a
 * restart.
 */
export function changeVersion(): number {
  return bus.version;
}
