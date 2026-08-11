import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ExcalidrawClientModule from "@drawstuff/excalidraw-adapter/client";

/**
 * What blocks a main-menu item from rendering in isolation is the i18n hook
 * chain (`useAppI18n` → adapter `useI18n` → an isolated `useAtomValue` from
 * upstream's `jotai-scope` `createIsolation()`), which throws without the
 * Excalidraw provider. `MainMenu.Item` / `ItemCustom` are a plain button/div
 * over defaulted contexts and are not the obstacle. So every item here is
 * unit-testable once the adapter's i18n hook is mocked.
 *
 * KNOWN GAP: the session-gated items that also need auth/tRPC/workspace state
 * (`workspace-switcher-item`, `dashboard-link-item`, `account-item`) and the
 * editor-state items (`theme-item`, `language-item`) have no direct coverage.
 * tests/e2e/excalidraw-smoke.spec.ts never authenticates, so it does not
 * exercise the session-gated ones either.
 */

vi.mock("@drawstuff/excalidraw-adapter/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ExcalidrawClientModule>();
  return {
    ...actual,
    useExcalidrawI18n: () => ({ t: (key: string) => key, langCode: "en" }),
  };
});

import { MenuActionItem } from "@/components/excalidraw/main-menu/menu-action-item";
import { NewSceneItem } from "@/components/excalidraw/main-menu/new-scene-item";
import { RenameSceneItem } from "@/components/excalidraw/main-menu/rename-scene-item";
import { SceneTitle } from "@/components/excalidraw/main-menu/scene-title";
import { SettingsItem } from "@/components/excalidraw/main-menu/settings-item";
import { SocialLinksItem } from "@/components/excalidraw/main-menu/social-links-item";

const actEnvironment = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(ui: ReactElement): void {
  act(() => root.render(ui));
}

function renderedItem(): HTMLElement {
  const item = container.querySelector<HTMLElement>(".dropdown-menu-item");
  if (!item) {
    throw new Error("the menu item did not render");
  }
  return item;
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MenuActionItem", () => {
  it("keeps the upstream dropdown item classes so it matches native items", () => {
    render(
      <MenuActionItem
        icon={<span data-testid="icon" />}
        label="Rename"
        onActivate={vi.fn()}
      />,
    );

    const item = renderedItem();
    expect(item.className).toBe("dropdown-menu-item dropdown-menu-item-base");
    expect(item.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(item.textContent).toBe("Rename");
  });

  it("activates on click", () => {
    const onActivate = vi.fn();
    render(
      <MenuActionItem icon={null} label="Rename" onActivate={onActivate} />,
    );

    act(() => {
      renderedItem().click();
    });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("uses a native button for keyboard activation", () => {
    render(<MenuActionItem icon={null} label="Rename" onActivate={vi.fn()} />);

    expect(renderedItem().tagName).toBe("BUTTON");
    expect(renderedItem().getAttribute("type")).toBe("button");
  });
});

describe("MenuActionItem wrappers", () => {
  const wrappers = [
    { name: "RenameSceneItem", Item: RenameSceneItem, label: "Rename scene" },
    { name: "NewSceneItem", Item: NewSceneItem, label: "New scene" },
  ];

  it.each(wrappers)("$name renders its translated label", ({ Item, label }) => {
    render(<Item onActivate={vi.fn()} />);

    expect(renderedItem().textContent).toBe(label);
  });

  it.each(wrappers)("$name activates on click", ({ Item }) => {
    const onActivate = vi.fn();
    render(<Item onActivate={onActivate} />);

    act(() => {
      renderedItem().click();
    });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsItem", () => {
  it("aligns with the native item spacing", () => {
    render(
      <SettingsItem
        href="/workspaces/00000000-0000-4000-8000-000000000001/settings"
        onNavigate={vi.fn()}
      />,
    );

    expect(container.firstElementChild?.classList.contains("mt-0!")).toBe(
      true,
    );
  });

  it("navigates to workspace settings and closes the native menu", () => {
    const onNavigate = vi.fn();
    render(
      <SettingsItem
        href="/workspaces/00000000-0000-4000-8000-000000000001/settings"
        onNavigate={onNavigate}
      />,
    );

    const link = container.querySelector("a");
    expect(link?.textContent).toContain("Settings");
    expect(link?.getAttribute("href")).toBe(
      "/workspaces/00000000-0000-4000-8000-000000000001/settings",
    );
    act(() => link?.click());
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("is disabled when no workspace can be resolved", () => {
    render(<SettingsItem onNavigate={vi.fn()} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });
});

describe("SocialLinksItem", () => {
  it("renders every social link as a new-tab link that cannot reach the opener", () => {
    render(<SocialLinksItem />);

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/EricTsai83/drawstuff",
      "https://bsky.app/profile/ericts.com",
      "https://ericts.com",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener");
      expect(link.className).toBe("dropdown-menu-item dropdown-menu-item-base");
    }
  });
});

describe("SceneTitle", () => {
  it("renders the scene name for compact menu presentations", () => {
    render(<SceneTitle sceneName="Quarterly plan" />);

    const title = container.querySelector("div");
    expect(title).not.toBeNull();
    if (!title) return;
    expect(title.textContent).toBe("Quarterly plan");
    expect(title.className).not.toContain("hidden");
  });
});
