import { NextResponse } from "next/server";
import { createAction, deleteAction, moveAction, updateAction } from "@/lib/store";
import { parseActionCreate, parseActionPatch } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * The "Need to action" backlog. Undated by design: these never reach the
 * calendar or iCloud. Moving a row to or from the board is a board action
 * ("fromBacklog" / "toBacklog" in /api/board), since it turns one kind into
 * the other.
 */
export async function POST(request: Request) {
  const parsed = parseActionCreate(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  return NextResponse.json({ action: createAction(parsed.value.title) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const parsed = parseActionPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const { id, title, done, reorder } = parsed.value;
  if (reorder && !moveAction(id, reorder)) {
    return NextResponse.json({ error: "That item is no longer there" }, { status: 404 });
  }
  updateAction(id, { title, done });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "An id is required" }, { status: 400 });
  deleteAction(id);
  return NextResponse.json({ ok: true });
}
