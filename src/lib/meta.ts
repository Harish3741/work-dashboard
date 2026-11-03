import { db } from "./db.js";

/**
 * The `app_meta` key/value scratchpad: scheduler bookkeeping, reminder links,
 * monitor state. Anything small that would otherwise want its own table.
 */

export function getMeta(key: string): string | null {
  const row = db().prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function deleteMeta(key: string): void {
  db().prepare("DELETE FROM app_meta WHERE key = ?").run(key);
}

/** JSON-valued meta; a missing or unparseable value yields the fallback. */
export function getJson<T>(key: string, fallback: T): T {
  const raw = getMeta(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  setMeta(key, JSON.stringify(value));
}
