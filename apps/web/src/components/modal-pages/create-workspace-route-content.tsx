import { AuthRequired } from "@/components/auth-required";
import { CreateWorkspaceContent } from "@/components/modal-pages/create-workspace-content";
import { getServerSession } from "@/lib/auth/server";
import { HydrateClient, api } from "@/trpc/server";

export async function CreateWorkspaceRouteContent({
  cancelAction,
}: {
  cancelAction: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) return <AuthRequired />;

  void api.workspace.listWithMeta.prefetch();
  return (
    <HydrateClient>
      <CreateWorkspaceContent cancelAction={cancelAction} />
    </HydrateClient>
  );
}
