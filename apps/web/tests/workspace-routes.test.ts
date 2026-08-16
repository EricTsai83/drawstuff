import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { matchWorkspaceRoute, routes } from "@/lib/routes";
import { workspaceRouteMeta } from "@/lib/workspace-route-meta";

const appRoot = resolve(import.meta.dirname, "../src/app");
const srcRoot = resolve(import.meta.dirname, "../src");

const SAMPLE_DYNAMIC_SEGMENT = "sample-id";

/** app 目錄片段 → 實際 pathname：去掉 intercept 前綴與 route group，動態段換成範例值。 */
function toPathname(segments: string[]): string {
  const parts = segments
    .map((segment) => segment.replace(/^(?:\((?:\.{1,3})\))+/, ""))
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) =>
      /^\[.+\]$/.test(segment) ? SAMPLE_DYNAMIC_SEGMENT : segment,
    );
  return `/${parts.join("/")}`;
}

function collectRoutePathnames(dir: string, segments: string[] = []): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return collectRoutePathnames(join(dir, entry.name), [
        ...segments,
        entry.name,
      ]);
    }
    return entry.name === "page.tsx" ? [toPathname(segments)] : [];
  });
}

describe("workspace management routes", () => {
  it("builds stable, encoded destinations", () => {
    expect(routes.dashboard()).toBe("/dashboard");
    expect(routes.dashboard("workspace id")).toBe(
      "/dashboard?workspaceId=workspace+id",
    );
    expect(routes.newWorkspace).toBe("/workspaces/new");
    expect(routes.workspaceSettings("id/with/slashes")).toBe(
      "/workspaces/id%2Fwith%2Fslashes/settings",
    );
  });

  it("defines explicit fallbacks and groups intercepted pages under one modal layout", () => {
    const expectedFiles = [
      "@overlay/default.tsx",
      "@overlay/page.tsx",
      "@overlay/[...catchAll]/page.tsx",
      "@overlay/(modal)/layout.tsx",
      "@overlay/(modal)/(.)dashboard/page.tsx",
      "@overlay/(modal)/(.)workspaces/new/page.tsx",
      "@overlay/(modal)/(.)workspaces/[workspaceId]/settings/page.tsx",
    ];

    for (const relativePath of expectedFiles) {
      expect(() =>
        readFileSync(resolve(appRoot, relativePath), "utf8"),
      ).not.toThrow();
    }

    const layoutSource = readFileSync(
      resolve(appRoot, "@overlay/(modal)/layout.tsx"),
      "utf8",
    );
    expect(layoutSource).toContain("<RouteOverlay>{children}</RouteOverlay>");
  });

  it("keeps presentation-neutral content free of history-close behavior", () => {
    const contentFiles = [
      "../src/components/modal-pages/dashboard-content.tsx",
      "../src/components/modal-pages/create-workspace-content.tsx",
      "../src/components/modal-pages/workspace-settings-content.tsx",
    ];

    for (const relativePath of contentFiles) {
      const source = readFileSync(
        resolve(import.meta.dirname, relativePath),
        "utf8",
      );
      expect(source).not.toContain("router.back(");
      expect(source).not.toContain("<RouteOverlay");
    }
  });

  it("round-trips every route builder through the matcher", () => {
    expect(matchWorkspaceRoute(routes.dashboard())).toEqual({
      kind: "dashboard",
    });
    expect(matchWorkspaceRoute(routes.newWorkspace)).toEqual({
      kind: "newWorkspace",
    });
    expect(
      matchWorkspaceRoute(routes.workspaceSettings("id/with/slashes")),
    ).toEqual({ kind: "workspaceSettings", workspaceId: "id/with/slashes" });

    // 壞掉的 escape sequence 不能讓 matcher 丟例外
    expect(matchWorkspaceRoute("/workspaces/%E0%A4%A/settings")).toEqual({
      kind: "workspaceSettings",
      workspaceId: "%E0%A4%A",
    });

    expect(matchWorkspaceRoute(routes.canvas)).toBeNull();
    expect(matchWorkspaceRoute("/workspaces/id/settings/extra")).toBeNull();
  });

  it("keeps every intercepted modal page addressable by the matcher", () => {
    const pathnames = collectRoutePathnames(
      resolve(appRoot, "@overlay/(modal)"),
    );

    expect(pathnames.sort()).toEqual([
      "/dashboard",
      "/workspaces/new",
      `/workspaces/${SAMPLE_DYNAMIC_SEGMENT}/settings`,
    ]);
    for (const pathname of pathnames) {
      // 新增 modal 路由卻沒登記進 matcher/metadata 時，RouteOverlay 會靜默退回無標題外殼
      expect(matchWorkspaceRoute(pathname), pathname).not.toBeNull();
    }
  });

  it("derives both workspace shells from one route metadata source", () => {
    expect(
      workspaceRouteMeta({ kind: "workspaceSettings", workspaceId: "ws-1" }),
    ).toEqual({
      titleKey: "workspace.settings.title",
      descriptionKey: "workspace.settings.description",
      backHref: routes.dashboard("ws-1"),
    });

    const shellFiles = [
      "app/(workspace)/dashboard/page.tsx",
      "app/(workspace)/workspaces/new/page.tsx",
      "app/(workspace)/workspaces/[workspaceId]/settings/page.tsx",
      "components/route-overlay.tsx",
    ];
    const ownedKeys = [
      '"workspace.settings.title"',
      '"workspace.settings.description"',
      '"dashboard.workspace.create"',
    ];

    for (const relativePath of shellFiles) {
      const source = readFileSync(resolve(srcRoot, relativePath), "utf8");
      expect(source, relativePath).toContain("workspaceRouteMeta");
      for (const key of ownedKeys) {
        expect(source, `${relativePath} restates ${key}`).not.toContain(key);
      }
    }
  });

  it("keeps settings navigation inside the shared modal history entry", () => {
    const overlaySource = readFileSync(
      resolve(srcRoot, "components/route-overlay.tsx"),
      "utf8",
    );
    const dashboardOverlaySource = readFileSync(
      resolve(appRoot, "@overlay/(modal)/(.)dashboard/page.tsx"),
      "utf8",
    );
    const dashboardListSource = readFileSync(
      resolve(srcRoot, "components/scene-search-list.tsx"),
      "utf8",
    );

    // 關閉 overlay 一律回到 canvas，整段 modal 只佔一個 history entry
    expect(overlaySource).toContain("router.replace(routes.canvas)");
    expect(overlaySource).not.toContain("router.back()");

    // modal 內的設定頁連結改用 replace，且由 context 決定而非 prop drilling
    expect(overlaySource).toContain("<RouteOverlayProvider>");
    expect(dashboardListSource).toContain("replace={isInRouteOverlay}");
    expect(dashboardListSource).not.toContain("replaceSettingsNavigation");
    expect(dashboardOverlaySource).not.toContain("replaceSettingsNavigation");
    expect(dashboardOverlaySource).toContain("showHeading={false}");
  });

  it("uses a full-width desktop filter toolbar below the search field", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/components/scene-search-list.tsx"),
      "utf8",
    );

    expect(source).toContain('className="flex min-w-0 flex-col gap-3"');
    expect(source).toContain('layout="toolbar"');
    expect(source).toContain(
      "grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(10rem,0.8fr)_auto]",
    );
    expect(source).toContain(
      'className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2"',
    );
  });
});
