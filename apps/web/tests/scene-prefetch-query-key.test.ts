// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import { createTRPCReact, getQueryKey } from "@trpc/react-query";
import type { AppRouter } from "@/server/api/root";

// 鎖定 M2 的 hydration 前提：dashboard-content.tsx 的 prefetchInfinite input
// （省略 undefined 欄位）必須與 scene-search-list.tsx 的 useInfiniteQuery input
// （顯式帶 undefined 欄位）hash 出同一個 query key，否則 prefetch 白跑。
// 升級 @trpc/react-query 或 @tanstack/react-query 時，此測試取代手動 network 檢查。

const trpc = createTRPCReact<AppRouter>();
const WORKSPACE_ID = "0198c6a2-1111-7777-8888-9999aaaabbbb";

// 與 dashboard-content.tsx 的 prefetchInfinite 相同
const serverPrefetchInput = {
  limit: 10,
  workspaceId: WORKSPACE_ID,
  archived: false,
};

// 與 scene-search-list.tsx 預設狀態（無 URL 篩選）的 useInfiniteQuery 相同
const clientDefaultInput = {
  limit: 10,
  workspaceId: WORKSPACE_ID,
  categoryId: undefined,
  search: undefined,
  archived: false,
  isPublished: undefined,
};

describe("dashboard prefetch query key", () => {
  it("server prefetchInfinite input hashes to the client default query key", () => {
    const serverKey = getQueryKey(
      trpc.scene.getUserScenesInfinite,
      serverPrefetchInput,
      "infinite",
    );
    const clientKey = getQueryKey(
      trpc.scene.getUserScenesInfinite,
      clientDefaultInput,
      "infinite",
    );
    expect(hashKey(serverKey)).toBe(hashKey(clientKey));
  });

  it("non-default filters hash to a different key (why prefetch is skipped)", () => {
    const serverKey = getQueryKey(
      trpc.scene.getUserScenesInfinite,
      serverPrefetchInput,
      "infinite",
    );
    const filteredKey = getQueryKey(
      trpc.scene.getUserScenesInfinite,
      { ...clientDefaultInput, isPublished: true },
      "infinite",
    );
    expect(hashKey(serverKey)).not.toBe(hashKey(filteredKey));
  });
});
