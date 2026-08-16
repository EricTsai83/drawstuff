import { WorkspaceSettingsRouteContent } from "@/components/modal-pages/workspace-settings-route-content";

export default async function WorkspaceSettingsOverlayPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceSettingsRouteContent workspaceId={workspaceId} />;
}
