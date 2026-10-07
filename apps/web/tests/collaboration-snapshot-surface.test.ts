import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/root";
import { testTrpcContext } from "./support/trpc-caller";
import type { TestDatabase } from "./support/pglite-db";

describe("retired tRPC snapshot surface", () => {
  it.each(["get", "put", "reset"])(
    "refuses the old %s endpoint for both anonymous and signed-in callers",
    async (action) => {
      for (const user of [null, "owner"]) {
        const response = await fetchRequestHandler({
          endpoint: "/api/trpc",
          router: appRouter,
          req: new Request(
            `https://app.test/api/trpc/collaborationSnapshot.${action}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ json: { roomId: "old-room" } }),
            },
          ),
          createContext: async () => testTrpcContext({} as TestDatabase, user),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toContain("NOT_FOUND");
      }
    },
  );
});
