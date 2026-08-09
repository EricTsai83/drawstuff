import DashboardContent from "@/components/modal-pages/dashboard-content";
import { RouteOverlay } from "@/components/route-overlay";

export default function DashboardOverlayPage() {
  return (
    <RouteOverlay titleKey="dashboard.title" variant="dashboard">
      <DashboardContent showHeading={false} />
    </RouteOverlay>
  );
}
