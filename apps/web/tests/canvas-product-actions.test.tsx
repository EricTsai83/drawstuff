import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ExcalidrawClientModule from "@drawstuff/excalidraw-adapter/client";
import { CloudUploadButton } from "@/components/excalidraw/cloud-upload-button";
import { CollaborationButton } from "@/components/excalidraw/collaboration-button";
import { ShareSceneButton } from "@/components/excalidraw/share-scene-button";
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
});
