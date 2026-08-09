import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { routes } from "@/lib/routes";

const appRoot = resolve(import.meta.dirname, "../src/app");

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

  it("defines explicit root, hard fallback, catch-all and specific intercepts", () => {
    const expectedFiles = [
      "@overlay/default.tsx",
      "@overlay/page.tsx",
      "@overlay/[...catchAll]/page.tsx",
      "@overlay/(.)dashboard/page.tsx",
      "@overlay/(.)workspaces/new/page.tsx",
      "@overlay/(.)workspaces/[workspaceId]/settings/page.tsx",
    ];

    for (const relativePath of expectedFiles) {
      expect(() =>
        readFileSync(resolve(appRoot, relativePath), "utf8"),
      ).not.toThrow();
    }
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

  it("keeps dashboard scrolling on the outer overlay without horizontal overflow", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/components/route-overlay.tsx"),
      "utf8",
    );

    expect(source).toContain("min-h-[calc(100dvh-4rem)]");
    expect(source).toContain("max-h-none");
    expect(source).toContain(
      '"fixed inset-0 z-50 overflow-x-hidden overflow-y-auto overscroll-contain"',
    );
    expect(source).toContain("overflow-visible");
    expect(source).toContain('? "contents"');
  });

  it("uses the same outer-scroll panel layout for non-dashboard overlays", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/components/route-overlay.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'viewportClassName="fixed inset-0 z-50 overflow-x-hidden overflow-y-auto overscroll-contain"',
    );
    expect(source).toContain("mx-auto my-8");
    expect(source).toContain("w-4/5");
    expect(source).not.toContain("min-h-0 w-full overflow-y-auto");
    expect(source).toContain("app-safe-header");
  });

  it("uses the same centered overlay header for dashboard and settings", () => {
    const overlaySource = readFileSync(
      resolve(import.meta.dirname, "../src/components/route-overlay.tsx"),
      "utf8",
    );
    const settingsSource = readFileSync(
      resolve(
        import.meta.dirname,
        "../src/app/@overlay/(.)workspaces/[workspaceId]/settings/page.tsx",
      ),
      "utf8",
    );

    expect(overlaySource).toContain("px-14 pt-6 pb-4 text-center sm:pt-10");
    expect(overlaySource).toContain(
      '"text-2xl leading-tight font-semibold lg:text-3xl"',
    );
    expect(overlaySource).toContain("(!descriptionKey || isCentered)");
    expect(settingsSource).toContain('variant="centered"');
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
