import { NextResponse } from "next/server";
import { dashboardState } from "@/lib/contacts";

export const dynamic = "force-dynamic";

/** Everything the Dashboard page renders, for its refetch after a change. */
export async function GET() {
  return NextResponse.json(dashboardState());
}
