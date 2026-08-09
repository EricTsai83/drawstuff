import { notFound } from "next/navigation";
import { z } from "zod";
import { AuthRequired } from "@/components/auth-required";
import { WorkspaceSettingsContent } from "@/components/modal-pages/workspace-settings-content";
import { getServerSession } from "@/lib/auth/server";
import { HydrateClient, api } from "@/trpc/server";

export async function WorkspaceSettingsRouteContent({
  workspaceId,
}: {
  workspaceId: string;
}) {
  if (!z.uuid().safeParse(workspaceId).success) notFound();

  const session = await getServerSession();
  if (!session) return <AuthRequired />;

  let ownedWorkspace: Awaited<ReturnType<typeof api.workspace.getOwned>>;
  try {
    ownedWorkspace = await api.workspace.getOwned({ id: workspaceId });
  } catch {
    notFound();
  }

  void api.workspace.listWithMeta.prefetch();

  return (
    <HydrateClient>
      <WorkspaceSettingsContent workspace={ownedWorkspace} />
    </HydrateClient>
  );
}
