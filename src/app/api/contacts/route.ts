import { NextResponse } from "next/server";
import {
  createContact,
  deleteContact,
  importContacts,
  moveContact,
  updateContact,
  type ContactInput,
} from "@/lib/contacts";
import { parseContactPatch, readContact } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "A body is required" }, { status: 400 });

  // Bulk import: the same payload shape, many rows. Matching is on email, so
  // running it twice updates rather than doubling the table.
  if (Array.isArray(body.contacts)) {
    const rows = body.contacts
      .map((row: unknown) => readContact(row))
      .filter((row: ContactInput | null): row is ContactInput => row !== null);
    if (!rows.length) {
      return NextResponse.json({ error: "No contacts with a name" }, { status: 400 });
    }
    return NextResponse.json(importContacts(rows), { status: 201 });
  }

  const contact = readContact(body);
  if (!contact) return NextResponse.json({ error: "A name is required" }, { status: 400 });
  return NextResponse.json({ contact: createContact(contact) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const parsed = parseContactPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const { id, target, patch } = parsed.value;
  if (target && !moveContact(id, target)) {
    return NextResponse.json({ error: "That contact is no longer there" }, { status: 404 });
  }
  if (Object.keys(patch).length) updateContact(id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "An id is required" }, { status: 400 });
  deleteContact(id);
  return NextResponse.json({ ok: true });
}
