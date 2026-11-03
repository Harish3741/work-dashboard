import { NextResponse } from "next/server";
import { changeVersion } from "@/lib/changes";

export const dynamic = "force-dynamic";

/**
 * A number that moves whenever anything the board shows changed — a tick or
 * rename that came back from the phone, an item the inbox added, a calendar
 * sync. The open page polls this (useChangeRefresh) and refetches when it
 * moves, so a change made elsewhere shows up without pressing Refresh.
 * Deliberately tiny: it is asked every few seconds.
 */
export function GET() {
  return NextResponse.json({ version: changeVersion() });
}
