import { WorkspaceSettingsRouteContent } from "@/components/modal-pages/workspace-settings-route-content";
import { RouteOverlay } from "@/components/route-overlay";

export default async function WorkspaceSettingsOverlayPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return (
    <RouteOverlay
      titleKey="workspace.settings.title"
      descriptionKey="workspace.settings.description"
      variant="centered"
    >
      <WorkspaceSettingsRouteContent workspaceId={workspaceId} />
    </RouteOverlay>
  );
}
