import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * App strings now come from `I18nProvider`, not from the adapter's i18n hook, so
 * a menu item no longer needs the Excalidraw provider to render: wrapping it in
 * `I18nProvider` is enough. `MainMenu.Item` / `ItemCustom` are a plain
 * button/div over defaulted contexts and were never the obstacle.
 *
 * KNOWN GAP: the session-gated items that also need auth/tRPC/workspace state
 * (`workspace-switcher-item`, `dashboard-link-item`, `account-item`) and the
 * editor-state items (`theme-item`, `language-item`) have no direct coverage.
 * tests/e2e/excalidraw-smoke.spec.ts never authenticates, so it does not
 * exercise the session-gated ones either.
 */

import { MenuActionItem } from "@/components/excalidraw/main-menu/menu-action-item";
import { NewSceneItem } from "@/components/excalidraw/main-menu/new-scene-item";
import { ProductActionsItems } from "@/components/excalidraw/main-menu/product-actions-items";
import { RenameSceneItem } from "@/components/excalidraw/main-menu/rename-scene-item";
import { SceneTitle } from "@/components/excalidraw/main-menu/scene-title";
import { SettingsItem } from "@/components/excalidraw/main-menu/settings-item";
import { SocialLinksItem } from "@/components/excalidraw/main-menu/social-links-item";
import { StorageUsageItem } from "@/components/excalidraw/main-menu/storage-usage-item";
import { I18nProvider } from "@/hooks/i18n-context";
import { en } from "@/lib/i18n/en";

const actEnvironment = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(ui: ReactElement): void {
  // 應用層字串現在由 I18nProvider 下發，元件不再自行讀 localStorage
  act(() =>
    root.render(
      <I18nProvider initialLanguage="en" initialDictionary={en}>
        {ui}
      </I18nProvider>,
    ),
  );
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

describe("ProductActionsItems", () => {
  it("removes ItemCustom's section gap between adjacent actions", () => {
    render(
      <ProductActionsItems
        actions={{
          collaboration: {
            status: "idle",
            isReadOnly: false,
            onActivate: vi.fn(),
          },
          cloudSave: { status: "idle", onActivate: vi.fn() },
          share: { status: "idle", onActivate: vi.fn() },
        }}
        onDismiss={vi.fn()}
      />,
    );

    const wrappers = Array.from(
      container.querySelectorAll<HTMLElement>(".dropdown-menu-item-custom"),
    );

    expect(wrappers).toHaveLength(3);
    expect(wrappers.every((item) => item.classList.contains("mt-0!"))).toBe(
      true,
    );
  });
});

describe("StorageUsageItem", () => {
  it("renders as a passive status without an extra section gap", () => {
    render(<StorageUsageItem />);

    const wrapper = container.querySelector<HTMLElement>(
      ".dropdown-menu-item-custom",
    );
    const status = container.querySelector<HTMLElement>('[role="status"]');

    expect(wrapper?.classList.contains("mt-0!")).toBe(true);
    expect(status?.classList.contains("cursor-default")).toBe(true);
    expect(
      status?.querySelector('[data-testid="storage-usage"]'),
    ).not.toBeNull();
    expect(status?.querySelector("button, a")).toBeNull();
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

    expect(container.firstElementChild?.classList.contains("mt-0!")).toBe(true);
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
  it("renders a responsive, truncating scene name for compact menu presentations", () => {
    render(<SceneTitle sceneName="Quarterly plan" />);

    const title = container.querySelector("div");
    const sceneName = container.querySelector("span");
    const titleContent = title?.firstElementChild;
    expect(title).not.toBeNull();
    if (!title) return;
    expect(title.textContent).toBe("Quarterly plan");
    expect(title.classList.contains("hidden")).toBe(false);
    expect(title.className).toContain("[contain:inline-size]");
    expect(title.className).toContain("overflow-hidden");
    expect(title.className).toContain("min-[730px]:text-base");
    expect(titleContent?.className).toContain("inline-flex");
    expect(titleContent?.className).toContain("max-w-full");
    expect(sceneName?.className).toContain("truncate");
    expect(sceneName?.className).toContain("min-w-0");
  });
});
