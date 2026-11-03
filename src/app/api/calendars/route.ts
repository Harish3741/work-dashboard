import { NextResponse } from "next/server";
import { createCalendar, deleteCalendar, listCalendars, updateCalendar } from "@/lib/store";
import { syncAll } from "@/lib/sync";
import { parseCalendarCreate, parseCalendarPatch } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ calendars: listCalendars() });
}

export async function POST(request: Request) {
  const parsed = parseCalendarCreate(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const calendar = createCalendar(parsed.value);
  syncAll().catch(() => {});
  return NextResponse.json({ calendar }, { status: 201 });
}

export async function PATCH(request: Request) {
  const parsed = parseCalendarPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  updateCalendar(parsed.value.id, parsed.value.patch);
  // A URL change invalidates the cache for that calendar.
  if (parsed.value.patch.url !== undefined) syncAll().catch(() => {});
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "A calendar id is required" }, { status: 400 });
  deleteCalendar(id);
  return NextResponse.json({ ok: true });
}
