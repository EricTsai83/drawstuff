import { act, renderHook } from "@testing-library/react";
import { dehydrate, hydrate } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchStreamLink,
  TRPCClientError,
} from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { zodResolver } from "@hookform/resolvers/zod";
import { formatDistanceToNow } from "date-fns";
import { zhTW } from "date-fns/locale";
import {
  withNuqsTestingAdapter,
  type OnUrlUpdateFunction,
} from "nuqs/adapters/testing";
import { useQueryState } from "nuqs";
import { type ResolverOptions } from "react-hook-form";
import SuperJSON from "superjson";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { sceneNameSchema } from "@/lib/schemas/scene";
import { cn } from "@/lib/utils";
import { createQueryClient } from "@/trpc/query-client";

type TestContext = {
  userId: string | null;
};

const t = initTRPC.context<TestContext>().create({
  transformer: SuperJSON,
});

let storedSceneName = "Original scene";

const dependencyTestRouter = t.router({
  protectedTimestamp: t.procedure.query(({ ctx }) => {
    if (!ctx.userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    return {
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      userId: ctx.userId,
    };
  }),
  sceneName: t.procedure.query(() => ({
    name: storedSceneName,
  })),
  renameScene: t.procedure
    .input(z.object({ name: sceneNameSchema }))
    .mutation(({ input }) => {
      storedSceneName = input.name;
      return { name: storedSceneName };
    }),
});

type DependencyTestRouter = typeof dependencyTestRouter;

function createTestClient(userId: string | null) {
  return createTRPCClient<DependencyTestRouter>({
    links: [
      httpBatchStreamLink({
        transformer: SuperJSON,
        url: "http://drawstuff.test/api/trpc",
        headers: {
          "x-trpc-source": "dependency-integration-test",
        },
        fetch: async (input, init) => {
          const request =
            input instanceof Request ? input : new Request(input, init);

          expect(request.headers.get("x-trpc-source")).toBe(
            "dependency-integration-test",
          );

          return fetchRequestHandler({
            endpoint: "/api/trpc",
            req: request,
            router: dependencyTestRouter,
            createContext: () => ({ userId }),
          });
        },
      }),
    ],
  });
}

describe("same-major dependency integrations", () => {
  it("streams tRPC results with SuperJSON and preserves auth errors", async () => {
    const authenticatedClient = createTestClient("user-1");

    await expect(
      authenticatedClient.protectedTimestamp.query(),
    ).resolves.toEqual({
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      userId: "user-1",
    });

    const unauthenticatedClient = createTestClient(null);
    const error = await unauthenticatedClient.protectedTimestamp
      .query()
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toMatchObject({
      data: {
        code: "UNAUTHORIZED",
      },
      message: "Authentication required",
    });
  });

  it("round-trips dates through the project React Query hydration policy", () => {
    const serverQueryClient = createQueryClient();
    const queryKey = ["scene", "detail", "scene-1"] as const;
    const createdAt = new Date("2026-07-26T01:02:03.000Z");

    serverQueryClient.setQueryData(queryKey, {
      createdAt,
      name: "Hydrated scene",
    });

    const serializedState = JSON.parse(
      JSON.stringify(dehydrate(serverQueryClient)),
    ) as ReturnType<typeof dehydrate>;
    const browserQueryClient = createQueryClient();
    hydrate(browserQueryClient, serializedState);

    const hydrated = browserQueryClient.getQueryData<{
      createdAt: Date;
      name: string;
    }>(queryKey);

    expect(hydrated).toEqual({
      createdAt,
      name: "Hydrated scene",
    });
    expect(hydrated?.createdAt).toBeInstanceOf(Date);
  });

  it("refetches invalidated cache data after a streamed mutation", async () => {
    storedSceneName = "Original scene";
    const client = createTestClient("user-1");
    const queryClient = createQueryClient();
    const queryKey = ["scene", "name"] as const;

    await expect(
      queryClient.fetchQuery({
        queryKey,
        queryFn: () => client.sceneName.query(),
      }),
    ).resolves.toEqual({ name: "Original scene" });

    await expect(
      client.renameScene.mutate({ name: "  Renamed scene  " }),
    ).resolves.toEqual({ name: "Renamed scene" });

    await queryClient.invalidateQueries({
      queryKey,
      refetchType: "all",
    });

    expect(queryClient.getQueryData(queryKey)).toEqual({
      name: "Renamed scene",
    });
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
  });

  it("maps Zod validation errors and returns transformed form values", async () => {
    const schema = z.object({
      name: sceneNameSchema,
    });
    type FormValues = z.input<typeof schema>;

    const resolver = zodResolver(schema);
    const options: ResolverOptions<FormValues> = {
      criteriaMode: "firstError",
      fields: {},
      names: ["name"],
      shouldUseNativeValidation: false,
    };

    const invalid = await resolver({ name: "   " }, undefined, options);
    expect(invalid.errors.name).toMatchObject({
      message: "Name is required",
      type: "too_small",
    });

    const valid = await resolver({ name: "  Scene  " }, undefined, options);
    expect(valid.errors).toEqual({});
    expect(valid.values).toEqual({ name: "Scene" });
  });

  it("formats localized relative timestamps and merges Tailwind conflicts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T02:00:00.000Z"));

    try {
      expect(
        formatDistanceToNow(new Date("2026-07-26T01:00:00.000Z"), {
          addSuffix: true,
          locale: zhTW,
        }),
      ).toBe("大約 1 小時前");
      expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps scene search state in the URL and clears the default value", async () => {
    const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
    const { result } = renderHook(
      () =>
        useQueryState("search", {
          defaultValue: "",
          clearOnDefault: true,
        }),
      {
        wrapper: withNuqsTestingAdapter({
          hasMemory: true,
          onUrlUpdate,
          searchParams: "?search=initial",
        }),
      },
    );

    expect(result.current[0]).toBe("initial");

    await act(async () => {
      await result.current[1]("diagram");
    });
    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryString: "?search=diagram",
      }),
    );

    await act(async () => {
      await result.current[1]("");
    });
    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryString: "",
      }),
    );
  });
});
