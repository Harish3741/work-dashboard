import { NextResponse } from "next/server";
import { getNote, setNote } from "@/lib/notes";
import { parseNote } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * Notes on one board item — a to-do or an event.
 *
 * Keyed by board item key, so a feed occurrence can carry a note without
 * being detached into a local copy. Nothing here reaches iCloud or Reminders.
 *
 *   GET  ?key=…        the note, "" when there is none
 *   POST {key, body}   write it; an empty body deletes it
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "An item key is required" }, { status: 400 });
  return NextResponse.json({ key, body: getNote(key) });
}

export async function POST(request: Request) {
  const parsed = parseNote(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  setNote(parsed.value.key, parsed.value.body);
  return NextResponse.json({ ok: true });
}
