import { NextResponse } from "next/server";
import { setCompletion } from "@/lib/store";
import { parseCompletion } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * Tick or untick an event. This is the only way a habit gets credited — there
 * is deliberately no habit-level "mark done" endpoint.
 */
export async function POST(request: Request) {
  const parsed = parseCompletion(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  try {
    setCompletion(parsed.value.key, parsed.value.completed);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update completion" },
      { status: 400 },
    );
  }
}
