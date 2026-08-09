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

  it("uses one responsive overlay shell with owned header and content scrolling", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/components/route-overlay.tsx"),
      "utf8",
    );

    expect(source).toContain("inset-0 grid h-dvh");
    expect(source).toContain("sm:w-[calc(100%-3rem)]");
    expect(source).toContain("lg:w-4/5");
    expect(source).toContain("grid-rows-[auto_minmax(0,1fr)]");
    expect(source).toContain("min-h-0 w-full overflow-y-auto");
    expect(source).toContain("app-safe-header");
  });
});
