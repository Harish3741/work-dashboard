import { NextResponse } from "next/server";
import { syncAllRecorded, syncStatus } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ sync: syncStatus() });
}

/** Manual refresh. Concurrent calls share one in-flight run; recorded like the hourly one. */
export async function POST() {
  const results = await syncAllRecorded();
  return NextResponse.json({ results, sync: syncStatus() });
}
