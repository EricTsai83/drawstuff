import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ExcalidrawClientModule from "@drawstuff/excalidraw-adapter/client";
import { CloudUploadButton } from "@/components/excalidraw/cloud-upload-button";
import { CollaborationButton } from "@/components/excalidraw/collaboration-button";
import { ShareSceneButton } from "@/components/excalidraw/share-scene-button";
import { TopRightControls } from "@/components/excalidraw/top-right-controls";
import { I18nProvider } from "@/hooks/i18n-context";
import { en } from "@/lib/i18n/en";

vi.mock("@drawstuff/excalidraw-adapter/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ExcalidrawClientModule>();
  return {
    ...actual,
    useExcalidrawI18n: () => ({ t: (key: string) => key, langCode: "en" }),
  };
});

vi.mock("@/lib/auth/client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user-1" } } }),
  },
}));

const actEnvironment = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

// 應用層字串現在由 I18nProvider 下發，元件不再自行讀 localStorage
function withI18n(ui: ReactElement): ReactElement {
  return (
    <I18nProvider initialLanguage="en" initialDictionary={en}>
      {ui}
    </I18nProvider>
  );
}

function render(ui: ReactElement): HTMLButtonElement {
  act(() => root.render(withI18n(ui)));
  const button = container.querySelector("button");
  if (!button) throw new Error("expected an action button");
  return button;
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

describe("Canvas product action presentations", () => {
  it.each([
    ["idle", "Waiting to upload to cloud", false],
    ["uploading", "Uploading to cloud", true],
    ["success", "Synced to cloud", false],
    ["error", "Upload failed, click to retry", false],
    ["offline", "Currently offline", false],
  ] as const)(
    "exposes cloud status %s with disabled and busy semantics",
    (status, label, isBusy) => {
      const button = render(
        <CloudUploadButton status={status} onClick={vi.fn()} />,
      );
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("aria-busy")).toBe(String(isBusy));
      expect(button.disabled).toBe(isBusy);
    },
  );

  it("uses the same share handler in compact-density and wide presentations", () => {
    const onClick = vi.fn();
    let button = render(
      <ShareSceneButton
        exportStatus="idle"
        presentation="regular"
        onClick={onClick}
      />,
    );
    act(() => button.click());
    expect(button.getAttribute("aria-label")).toBe("Share");

    act(() =>
      root.render(
        withI18n(
          <ShareSceneButton
            exportStatus="idle"
            presentation="wide"
            onClick={onClick}
          />,
        ),
      ),
    );
    button = container.querySelector("button") as HTMLButtonElement;
    act(() => button.click());
    expect(button.textContent).toContain("Share");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("keeps collaboration read-only and joining states accessible at either density", () => {
    const regular = render(
      <CollaborationButton
        status="joining"
        isReadOnly
        presentation="regular"
        onClick={vi.fn()}
      />,
    );
    expect(regular.getAttribute("aria-busy")).toBe("true");
    expect(regular.getAttribute("aria-label")).toContain("View only");

    act(() =>
      root.render(
        withI18n(
          <CollaborationButton
            status="sync-blocked"
            isReadOnly
            presentation="wide"
            onClick={vi.fn()}
          />,
        ),
      ),
    );
    expect(container.textContent).toContain("Sync stopped");
    expect(
      container.querySelector("button")?.getAttribute("aria-label"),
    ).toContain("View only");
  });

  it("groups save with the compact shortcut actions", async () => {
    const save = vi.fn();
    const collaborate = vi.fn();
    const share = vi.fn();
    const library = vi.fn();

    act(() =>
      root.render(
        withI18n(
          <TopRightControls
            actions={{
              collaboration: {
                status: "idle",
                isReadOnly: false,
                onActivate: collaborate,
              },
              cloudSave: { status: "idle", onActivate: save },
              share: { status: "idle", onActivate: share },
            }}
            isMobile={false}
            onLibraryActivate={library}
          />,
        ),
      ),
    );

    const shortcutButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Quick actions"]',
    );
    expect(
      container.querySelector('[data-slot="floating-shortcut-caption"]'),
    ).toBeNull();
    expect(shortcutButton).not.toBeNull();
    expect(shortcutButton?.style.width).toBe("40px");

    await act(async () => {
      shortcutButton?.click();
      await Promise.resolve();
    });

    expect(shortcutButton?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="floating-shortcut-trigger-surface"]',
      )?.style.transform,
    ).toBe("scale(0.75)");
    expect(
      container
        .querySelector<HTMLElement>(
          '[data-slot="floating-shortcut-trigger-face"]',
        )
        ?.classList.contains("opacity-0"),
    ).toBe(true);
    expect(
      container
        .querySelector<HTMLElement>(
          '[data-slot="floating-shortcut-close-face"]',
        )
        ?.classList.contains("opacity-100"),
    ).toBe(true);
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="floating-shortcut-close-face"]',
      )?.style.transitionDelay,
    ).toBe("34ms");

    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    expect(items[0]?.style.width).toBe("36px");
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="floating-shortcut-menu"]',
      )?.style.gap,
    ).toBe("6px");
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="floating-shortcut-action-row"]',
      )?.style.gap,
    ).toBe("6px");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Library",
      "Collaborate",
      "Share",
      "Save to cloud",
    ]);
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-slot="floating-shortcut-action-label"]',
        ),
        (label) => label.textContent,
      ),
    ).toEqual(["Library", "Collaborate", "Share", "Save to cloud"]);

    act(() => items[3]?.click());
    expect(save).toHaveBeenCalledOnce();
    expect(shortcutButton?.getAttribute("aria-expanded")).toBe("false");
    expect(library).not.toHaveBeenCalled();
    expect(collaborate).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("shows the cloud save lifecycle outside the closed shortcut trigger", () => {
    const currentBadgeLabel = () =>
      Array.from(
        container.querySelectorAll('[data-slot="status-badge-label"]'),
      ).at(-1)?.textContent;
    const renderControls = (status: "uploading" | "success" | "error") =>
      root.render(
        withI18n(
          <TopRightControls
            actions={{
              collaboration: {
                status: "idle",
                isReadOnly: false,
                onActivate: vi.fn(),
              },
              cloudSave: { status, onActivate: vi.fn() },
              share: { status: "idle", onActivate: vi.fn() },
            }}
            isMobile={false}
            onLibraryActivate={vi.fn()}
          />,
        ),
      );

    act(() => renderControls("uploading"));
    const badge = container.querySelector('[data-testid="cloud-save-status"]');
    expect(badge?.getAttribute("role")).toBe("status");
    expect(badge?.classList.contains("h-8")).toBe(true);
    expect(badge?.parentElement?.classList.contains("items-center")).toBe(true);
    expect(
      badge
        ?.querySelector('[data-slot="spinner"]')
        ?.classList.contains("animate-spin"),
    ).toBe(true);
    expect(currentBadgeLabel()).toBe("Saving…");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[role="menuitem"][aria-label="Save to cloud"]',
      )?.disabled,
    ).toBe(true);

    act(() => renderControls("success"));
    expect(currentBadgeLabel()).toBe("Saved");

    act(() => renderControls("error"));
    expect(currentBadgeLabel()).toBe("Failed");
  });
});
