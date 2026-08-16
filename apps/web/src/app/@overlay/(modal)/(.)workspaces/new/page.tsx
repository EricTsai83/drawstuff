import { CreateWorkspaceRouteContent } from "@/components/modal-pages/create-workspace-route-content";
import { RouteBackButton } from "@/components/route-back-button";

export default function NewWorkspaceOverlayPage() {
  return <CreateWorkspaceRouteContent cancelAction={<RouteBackButton />} />;
}
