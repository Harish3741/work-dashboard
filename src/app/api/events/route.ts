import { NextResponse } from "next/server";
import {
  createLocalEvent,
  moveOccurrence,
  deleteLocalEvent,
  hideOccurrence,
  updateLocalEvent,
} from "@/lib/store";
import { parseEventCreate, parseEventPatch } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** Create a local event. It lives in this app's database only. */
export async function POST(request: Request) {
  const parsed = parseEventCreate(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const id = createLocalEvent(parsed.value);
  return NextResponse.json({ id, key: `local:${id}` }, { status: 201 });
}

/** Update or move an event. Moving a feed event detaches a local copy. */
export async function PATCH(request: Request) {
  const parsed = parseEventPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const req = parsed.value;

  try {
    if (req.kind === "move") {
      const moved = moveOccurrence(req.key, req.toYmd, req.toStartMin);
      return NextResponse.json(moved);
    }
    updateLocalEvent(req.id, req.patch);
    return NextResponse.json({ key: req.key });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update event" },
      { status: 400 },
    );
  }
}

/**
 * Delete an event from the board. Local events are removed (detached copies
 * restore the hidden feed original); feed occurrences are hidden here only,
 * since the feed is read-only — they stay in your calendar.
 */
export async function DELETE(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key) return NextResponse.json({ error: "An event key is required" }, { status: 400 });
  if (key.startsWith("local:")) {
    const id = key.slice("local:".length);
    deleteLocalEvent(id);
    return NextResponse.json({ ok: true });
  }
  if (!hideOccurrence(key)) {
    return NextResponse.json({ error: "No such event" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, hidden: true });
}
