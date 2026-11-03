import DashboardView from "@/components/dashboard/DashboardView";
import { todayYmd } from "@/lib/time";
import { buildState } from "@/lib/view";
import { dashboardState } from "@/lib/contacts";

export const dynamic = "force-dynamic";

export default function Page() {
  const today = todayYmd();
  return (
    <DashboardView
      initial={buildState("month", today, today)}
      initialDashboard={dashboardState()}
    />
  );
}
