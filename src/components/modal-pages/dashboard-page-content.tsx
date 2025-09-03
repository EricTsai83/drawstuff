import { AuthRequired } from "@/components/auth-required";
import { OverlayModal } from "@/components/overlay-modal";
import SceneSearchListNoSSR from "../scene-search-list.no-ssr";
import { getServerSession } from "@/lib/auth/server";
import { cn } from "@/lib/utils";
import { HydrateClient, api } from "@/trpc/server";

export default async function DashboardPageContent() {
  const session = await getServerSession();

  const isAuthenticated = !!session;

  if (isAuthenticated) {
    void api.workspace.listWithMeta.prefetch();
    void api.scene.getUserScenesInfinite.prefetch({ limit: 12 });
  }

  return (
    <OverlayModal
      overlayClassName="pt-6"
      closeDelayMs={0}
      contentClassName={cn(
        "bg-background mx-auto min-h-full w-4/5 rounded-none border-0 flex items-center justify-center",
      )}
    >
      {isAuthenticated ? (
        <HydrateClient>
          <SceneSearchListNoSSR />
        </HydrateClient>
      ) : (
        <AuthRequired />
      )}
    </OverlayModal>
  );
}
