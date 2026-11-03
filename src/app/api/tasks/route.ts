import { NextResponse } from "next/server";
import { createTask, deleteTask, updateTask } from "@/lib/store";
import { parseTaskCreate, parseTaskPatch } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * Board to-dos. These are not events: they never reach the calendar grid and
 * never reach a calendar. The checks live in lib/validate.
 */
export async function POST(request: Request) {
  const parsed = parseTaskCreate(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  return NextResponse.json({ task: createTask(parsed.value) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const parsed = parseTaskPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  updateTask(parsed.value.id, parsed.value.patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "A task id is required" }, { status: 400 });
  deleteTask(id);
  return NextResponse.json({ ok: true });
}
