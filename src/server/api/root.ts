import { sceneRouter } from "@/server/api/routers/scene";
import { workspaceRouter } from "@/server/api/routers/workspace";
import { sharedSceneRouter } from "@/server/api/routers/shared-scene";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
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
