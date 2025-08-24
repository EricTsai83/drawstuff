import ExcalidrawClientSideWrapper from "@/components/excalidraw/excalidraw-client-wrapper";
import { api } from "@/trpc/server";
import { getServerSession } from "@/lib/auth/server";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure the user's default workspace exists as soon as they access the workspace area
  const session = await getServerSession();
  if (session) {
    await api.workspace.getOrCreateDefault();
  }

  return (
    <>
      <ExcalidrawClientSideWrapper />
      {children}
    </>
  );
}
