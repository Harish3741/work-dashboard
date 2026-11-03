import CalendarApp from "@/components/CalendarApp";
import { todayYmd } from "@/lib/time";
import { buildState } from "@/lib/view";

export const dynamic = "force-dynamic";

export default function Page() {
  const today = todayYmd();
  return <CalendarApp initial={buildState("month", today, today)} />;
}
