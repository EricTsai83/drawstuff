import { CreateWorkspaceRouteContent } from "@/components/modal-pages/create-workspace-route-content";
import { RouteBackButton } from "@/components/route-back-button";
import { RouteOverlay } from "@/components/route-overlay";

export default function NewWorkspaceOverlayPage() {
  return (
    <RouteOverlay
      titleKey="dashboard.workspace.create"
      descriptionKey="dashboard.workspace.createDialog.description"
    >
      <CreateWorkspaceRouteContent cancelAction={<RouteBackButton />} />
    </RouteOverlay>
  );
}
