import { categoryRouter } from "@/server/api/routers/category";
import { collaborationAssetRouter } from "@/server/api/routers/collaboration-asset";
import { collaborationRoomRouter } from "@/server/api/routers/collaboration-room";
import { collaborationSnapshotRouter } from "@/server/api/routers/collaboration-snapshot";
import { sceneRouter } from "@/server/api/routers/scene";
import { workspaceRouter } from "@/server/api/routers/workspace";
import { sharedSceneRouter } from "@/server/api/routers/shared-scene";
import { personalLibraryRouter } from "@/server/api/routers/personal-library";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";
import { adminRouter } from "@/server/api/routers/admin";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  admin: adminRouter,
  category: categoryRouter,
  collaborationAsset: collaborationAssetRouter,
  collaborationRoom: collaborationRoomRouter,
  collaborationSnapshot: collaborationSnapshotRouter,
  personalLibrary: personalLibraryRouter,
  scene: sceneRouter,
  sharedScene: sharedSceneRouter,
  workspace: workspaceRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
