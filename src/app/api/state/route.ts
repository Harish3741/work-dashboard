import { NextResponse } from "next/server";
import { todayYmd } from "@/lib/time";
import { buildState, type ViewMode } from "@/lib/view";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const view: ViewMode = params.get("view") === "week" ? "week" : "month";
  const anchor = params.get("anchor") ?? todayYmd();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    return NextResponse.json({ error: "Invalid anchor date" }, { status: 400 });
  }
  return NextResponse.json(buildState(view, anchor, todayYmd()));
}
