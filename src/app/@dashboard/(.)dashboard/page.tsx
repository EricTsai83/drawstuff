import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { ProjectSearchList } from "@/components/project-search-list";

export default function DashboardModalPage() {
  return (
    <DashboardOverlayModal>
      <ProjectSearchList />
    </DashboardOverlayModal>
  );
}
