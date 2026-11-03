import { NextResponse } from "next/server";
import { createPause, deletePause, listPauses } from "@/lib/pauses";
import { parsePauseCreate } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * Time away. Created from the board ("travel …" → return date) or, as a
 * pending proposal, by the message inbox; deleted from the sidebar chip.
 */
export async function GET() {
  return NextResponse.json({ pauses: listPauses() });
}

export async function POST(request: Request) {
  const parsed = parsePauseCreate(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  return NextResponse.json(
    { pause: createPause({ ...parsed.value, source: "board" }) },
    { status: 201 },
  );
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "An id is required" }, { status: 400 });
  deletePause(id);
  return NextResponse.json({ ok: true });
}
