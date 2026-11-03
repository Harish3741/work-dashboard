import StreaksApp from "@/components/StreaksApp";
import { todayYmd } from "@/lib/time";
import { buildState } from "@/lib/view";
import { buildStreakMatrix } from "@/lib/streaks";

export const dynamic = "force-dynamic";

export default function Page() {
  const today = todayYmd();
  const year = Number(today.slice(0, 4));
  return <StreaksApp initial={buildState("month", today, today)} matrix={buildStreakMatrix(year, today)} />;
}
