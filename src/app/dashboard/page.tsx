import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { ProjectSearchList } from "@/components/project-search-list";

export default async function DashboardPage() {
  return (
    <DashboardOverlayModal>
      <ProjectSearchList />
    </DashboardOverlayModal>
  );
}
