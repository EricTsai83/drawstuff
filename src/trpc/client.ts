import { createTRPCProxyClient, httpBatchStreamLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { AppRouter } from "@/server/api/root";
import { getBaseUrl } from "@/lib/base-url";

function createClient() {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        transformer: SuperJSON,
        url: getBaseUrl() + "/api/trpc",
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
