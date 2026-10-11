import {
  defaultShouldDehydrateQuery,
  QueryClient,
} from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import SuperJSON from "superjson";

import type { AppRouter } from "@/server/api/root";

/** Retries transient failures; a 4xx answers the same way again. */
const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status =
    error instanceof TRPCClientError
      ? (error as TRPCClientError<AppRouter>).data?.httpStatus
      : undefined;
  return failureCount < 3 && !(status !== undefined && status < 500);
};

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, we usually want to set some default staleTime
        // above 0 to avoid refetching immediately on the client
        staleTime: 30 * 1000,
        retry: retryTransient,
      },
      dehydrate: {
        serializeData: SuperJSON.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
      hydrate: {
        deserializeData: SuperJSON.deserialize,
      },
    },
  });
