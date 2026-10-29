// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";
import { useLoadSceneWithConfirm } from "@/hooks/excalidraw/use-load-scene-with-confirm";

vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => ({ currentSceneId: "current" }),
}));
vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mountFlow() {
  const upload = vi.fn(async () => false);
  const apply = vi.fn(async () => ({ ok: true as const }));
  let confirm!: ReturnType<typeof useSceneChangeConfirm>;
  let load!: ReturnType<typeof useLoadSceneWithConfirm>;
  function Probe() {
    const nextConfirm = useSceneChangeConfirm();
    const nextLoad = useLoadSceneWithConfirm({
      hasCurrentContent: () => true,
      requestSceneChangeDecision: nextConfirm.requestSceneChangeDecision,
      setSceneChangeLoading: nextConfirm.setSceneChangeDialogLoading,
      closeSceneChangeConfirm: nextConfirm.closeSceneChangeDialog,
      uploadSceneToCloud: upload,
      applyRemoteScene: apply,
    });
    useEffect(() => {
      confirm = nextConfirm;
      load = nextLoad;
    }, [nextConfirm, nextLoad]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  let loading!: Promise<void>;
  act(() => {
    loading = load.loadSceneWithConfirm({ sceneId: "target" });
  });
  return {
    upload,
    apply,
    get confirm() {
      return confirm;
    },
    loading,
    choose: async (choice: "save" | "switch" | "cancel") => {
      await act(async () => {
        confirm.resolveSceneChangeDecision(choice);
        if (choice === "cancel")
          confirm.handleSceneChangeDialogOpenChange(false);
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("scene change after a failed save", () => {
  it("accepts repeated retries and loads only after saving succeeds", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await flow.choose("save");
      expect(flow.upload).toHaveBeenCalledTimes(2);
      expect(flow.apply).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(true);
      expect(flow.confirm.isSceneChangeDialogLoading).toBe(false);
      flow.upload.mockResolvedValueOnce(true);
      await flow.choose("save");
      await flow.loading;
      expect(flow.upload).toHaveBeenCalledTimes(3);
      expect(flow.apply).toHaveBeenCalledExactlyOnceWith({
        sceneId: "target",
        getActiveTheme: undefined,
      });
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it("allows switching without another save after an upload rejects", async () => {
    const flow = mountFlow();
    try {
      flow.upload.mockRejectedValueOnce(new Error("network unavailable"));
      await flow.choose("save");
      expect(flow.confirm.isSceneChangeDialogLoading).toBe(false);
      expect(flow.apply).not.toHaveBeenCalled();
      await flow.choose("switch");
      await flow.loading;
      expect(flow.upload).toHaveBeenCalledTimes(1);
      expect(flow.apply).toHaveBeenCalledTimes(1);
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it("allows cancelling after a failed save without replacing the canvas", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await flow.choose("cancel");
      await flow.loading;
      expect(flow.apply).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it("treats closing the re-armed dialog as cancel", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await act(async () =>
        flow.confirm.handleSceneChangeDialogOpenChange(false),
      );
      await flow.loading;
      expect(flow.apply).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it("settles the pending load when an external flow closes the retry dialog", async () => {
    const flow = mountFlow();
    let settled = false;
    void flow.loading.then(() => {
      settled = true;
    });
    try {
      await flow.choose("save");
      expect(settled).toBe(false);
      await act(async () => flow.confirm.closeSceneChangeDialog());
      expect(settled).toBe(true);
      expect(flow.apply).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });
});
