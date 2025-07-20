import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { DrawingSearchList } from "@/components/drawing-search-list";

export default function DashboardModalPage() {
  return (
    <DashboardOverlayModal>
      <DrawingSearchList />
    </DashboardOverlayModal>
  );
}
