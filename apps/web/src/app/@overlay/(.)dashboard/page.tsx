import DashboardContent from "@/components/modal-pages/dashboard-content";
import { RouteOverlay } from "@/components/route-overlay";

export default async function DashboardOverlayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <RouteOverlay titleKey="dashboard.title" variant="dashboard">
      <DashboardContent searchParams={await searchParams} />
    </RouteOverlay>
  );
}
