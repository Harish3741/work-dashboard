import { NextResponse } from "next/server";
import { todayYmd } from "@/lib/time";
import { buildStreakMatrix } from "@/lib/streaks";

export const dynamic = "force-dynamic";

/**
 * The /streaks page as JSON, for its refetch after a wake.
 *
 *   ?year=2025   a past year's matrix (defaults to the current one)
 */
export async function GET(request: Request) {
  const today = todayYmd();
  const raw = new URL(request.url).searchParams.get("year");
  const year = raw === null ? Number(today.slice(0, 4)) : Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Invalid year" }, { status: 400 });
  }
  return NextResponse.json({ matrix: buildStreakMatrix(year, today) });
}
