import { db, newId, nowIso } from "./db.js";
import { indexForNeighbours } from "./order.js";

/**
 * The Dashboard's contacts: the people behind your work. Added by hand or
 * bulk-imported (POST /api/contacts with { contacts: [...] }).
 */

export type ContactRecord = {
  id: string;
  name: string;
  role: string | null;
  org: string | null;
  email: string | null;
  phone: string | null;
  event: string | null;
  category: string | null;
  position: number;
};

export type DashboardState = {
  contacts: ContactRecord[];
};

export type MoveTarget =
  | { beforeId: string | null; afterId: string | null }
  | { index: number };

const CONTACT_COLUMNS = "id, name, role, org, email, phone, event, category, position";

export function listContacts(): ContactRecord[] {
  return db()
    .prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts ORDER BY position, rowid`)
    .all() as ContactRecord[];
}

export type ContactInput = Partial<Omit<ContactRecord, "id" | "position">> & { name: string };

/** `id`: insert-if-absent, so a replayed create changes nothing. */
export function createContact(input: ContactInput, id?: string): ContactRecord {
  const conn = db();
  if (id) {
    const existing = conn.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ?`).get(id) as
      | ContactRecord
      | undefined;
    if (existing) return existing;
  }
  const max = conn
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM contacts")
    .get() as { p: number };
  const record: ContactRecord = {
    id: id ?? newId(),
    name: input.name.trim(),
    role: blankToNull(input.role),
    org: blankToNull(input.org),
    email: blankToNull(input.email),
    phone: blankToNull(input.phone),
    event: blankToNull(input.event),
    category: blankToNull(input.category),
    position: max.p + 1,
  };
  conn
    .prepare(
      `INSERT INTO contacts (id, name, role, org, email, phone, event, category, position, created_at)
       VALUES (@id, @name, @role, @org, @email, @phone, @event, @category, @position, @createdAt)`,
    )
    .run({ ...record, createdAt: nowIso() });
  return record;
}

const CONTACT_FIELDS = ["name", "role", "org", "email", "phone", "event", "category"] as const;

export function updateContact(id: string, patch: Partial<ContactInput>): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const field of CONTACT_FIELDS) {
    if (patch[field] === undefined) continue;
    sets.push(`${field} = @${field}`);
    params[field] = field === "name" ? String(patch.name).trim() : blankToNull(patch[field]);
  }
  if (!sets.length) return false;
  const result = db().prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return result.changes > 0;
}

export function deleteContact(id: string): void {
  db().prepare("DELETE FROM contacts WHERE id = ?").run(id);
}

/**
 * Bulk import, matching on email first and then on name within the same event.
 * An import that ran twice must update rows rather than double the table, and
 * it must never blank a detail the user typed by hand with an empty one.
 */
export function importContacts(rows: ContactInput[]): { added: number; updated: number } {
  const conn = db();
  let added = 0;
  let updated = 0;
  conn.transaction(() => {
    for (const row of rows) {
      const name = row.name?.trim();
      if (!name) continue;
      const email = blankToNull(row.email);
      // Email first, then name within the same event — and the fallback runs
      // when the email MISSES too, not only when there is no email. A sign-up
      // sheet imported before addresses were collected, then re-imported with
      // them, is the normal case, and matching on email alone would file the
      // same person twice.
      const byEmail = email
        ? (conn
            .prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE LOWER(email) = LOWER(?)`)
            .get(email) as ContactRecord | undefined)
        : undefined;
      const existing =
        byEmail ??
        (conn
          .prepare(
            `SELECT ${CONTACT_COLUMNS} FROM contacts
              WHERE LOWER(name) = LOWER(?) AND IFNULL(LOWER(event), '') = IFNULL(LOWER(?), '')`,
          )
          .get(name, blankToNull(row.event)) as ContactRecord | undefined);

      if (!existing) {
        createContact({ ...row, name });
        added += 1;
        continue;
      }

      const patch: Partial<ContactInput> = {};
      for (const field of CONTACT_FIELDS) {
        if (field === "name") continue;
        const incoming = blankToNull(row[field]);
        if (incoming && !existing[field]) patch[field] = incoming;
      }
      if (Object.keys(patch).length && updateContact(existing.id, patch)) updated += 1;
    }
  })();
  return { added, updated };
}

export function moveContact(id: string, target: MoveTarget): boolean {
  const conn = db();
  let moved = false;
  conn.transaction(() => {
    const all = (
      conn.prepare("SELECT id FROM contacts ORDER BY position, rowid").all() as { id: string }[]
    ).map((r) => r.id);
    if (!all.includes(id)) return;
    const ids = all.filter((other) => other !== id);
    const index =
      "index" in target
        ? Math.max(0, Math.min(target.index, ids.length))
        : indexForNeighbours(ids, target.beforeId, target.afterId);
    if (index === null) return;
    ids.splice(index, 0, id);
    const setPosition = conn.prepare("UPDATE contacts SET position = ? WHERE id = ?");
    ids.forEach((other, i) => setPosition.run(i, other));
    moved = true;
  })();
  return moved;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/* --------------------------------------------------------------------- view */

export function dashboardState(): DashboardState {
  return { contacts: listContacts() };
}
