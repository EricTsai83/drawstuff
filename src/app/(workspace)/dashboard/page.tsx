import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { DrawingSearchList } from "@/components/drawing-search-list";

export default async function DashboardPage() {
  return (
    <DashboardOverlayModal>
      <DrawingSearchList />
    </DashboardOverlayModal>
  );
}
