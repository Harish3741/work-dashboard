import DashboardApp from "@/components/DashboardApp";
import { todayYmd } from "@/lib/time";
import { buildState } from "@/lib/view";

export const dynamic = "force-dynamic";

export default function Page() {
  const today = todayYmd();
  return <DashboardApp initial={buildState("month", today, today)} />;
}
