import { createTRPCProxyClient, httpBatchStreamLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { AppRouter } from "./types";
import { getBaseUrl } from "@/lib/base-url";

function createClient() {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        transformer: SuperJSON,
        url: getBaseUrl() + "/api/trpc",
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            credentials: "include",
          }),
      }),
    ],
  });
}

type TRPCClient = ReturnType<typeof createClient>;

let browserClient: TRPCClient | undefined = undefined;

export function getTrpcClient(): TRPCClient {
  if (typeof window === "undefined") {
    return createClient();
  }

  browserClient ??= createClient();

  return browserClient;
}
