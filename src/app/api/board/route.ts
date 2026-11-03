import { NextResponse } from "next/server";
import {
  moveActionToBoard,
  moveBoardItem,
  moveTaskToBacklog,
  setItemTime,
  unpinBoardItem,
} from "@/lib/board";
import { todayYmd } from "@/lib/time";
import { boardDays } from "@/lib/view";
import { parseBoardRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * Board items — events and to-dos together. Ordering and times are properties
 * of the board, not of either underlying kind, so they live here rather than
 * under /api/tasks or /api/events.
 *
 *   action: "move"   reorder within a day, or move to another day
 *   action: "time"   set or clear an item's start time
 *   action: "unpin"  forget a hand-set position, sorting by time again
 *   action: "fromBacklog"  a "Need to action" item (itemKey "action:<id>")
 *                          dropped onto a day becomes a to-do there
 *   action: "toBacklog"    a to-do dropped into "Need to action" joins it,
 *                          between beforeId and afterId
 *
 * Where a drop landed is read by `boardMoveTarget` (lib/validate): neighbour
 * keys from the browser, a bare index from the phone's older queue.
 */
export async function POST(request: Request) {
  const parsed = parseBoardRequest(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const req = parsed.value;

  try {
    if (req.action === "move") {
      const result = moveBoardItem(
        req.itemKey,
        req.fromYmd,
        req.toYmd,
        req.target,
        boardDays(todayYmd()),
      );
      return NextResponse.json(result);
    }

    if (req.action === "time") {
      return NextResponse.json(setItemTime(req.itemKey, req.ymd, req.startMin));
    }

    if (req.action === "fromBacklog") {
      const result = moveActionToBoard(req.actionId, req.toYmd, req.target, boardDays(todayYmd()));
      return NextResponse.json(result);
    }

    if (req.action === "toBacklog") {
      const result = moveTaskToBacklog(req.itemKey, {
        beforeId: req.beforeId,
        afterId: req.afterId,
      });
      return NextResponse.json(result);
    }

    unpinBoardItem(req.ymd, req.itemKey);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update the board" },
      { status: 400 },
    );
  }
}
