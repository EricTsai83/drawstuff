import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { SceneSearchList } from "@/components/scene-search-list";

export default function DashboardModalPage() {
  return (
    <DashboardOverlayModal>
      <SceneSearchList />
    </DashboardOverlayModal>
  );
}
