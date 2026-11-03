import { NextResponse } from "next/server";
import { createHabit, deleteHabit, listHabits, titleSuggestions, updateHabit } from "@/lib/store";
import { parseHabitCreate, parseHabitPatch } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("suggestions") !== null) {
    return NextResponse.json({ titles: titleSuggestions(params.get("calendarId") || null) });
  }
  return NextResponse.json({ habits: listHabits(true) });
}

export async function POST(request: Request) {
  const parsed = parseHabitCreate(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  return NextResponse.json({ habit: createHabit(parsed.value) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const parsed = parseHabitPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  updateHabit(parsed.value.id, parsed.value.patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "A habit id is required" }, { status: 400 });
  deleteHabit(id);
  return NextResponse.json({ ok: true });
}
