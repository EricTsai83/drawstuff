// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useCanvasHandoff } from "@/hooks/excalidraw/use-canvas-handoff";
import { useSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";

vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => ({
    suppressDirtyTracking: vi.fn(),
    resumeDirtyTracking: vi.fn(),
    getCurrentSceneIdentity: vi.fn(),
  }),
}));
vi.mock("@/lib/collab/personal-draft", () => ({
  preservePersonalDraft: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mountFlow() {
  const upload = vi.fn(async () => false);
  const reset = vi.fn();
  const api = {
    resetScene: reset,
    getAppState: () => ({ viewModeEnabled: false }),
    updateScene: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;
  let confirm!: ReturnType<typeof useSceneChangeConfirm>;
  let handoff!: ReturnType<typeof useCanvasHandoff>;
  function Probe() {
    const c = useSceneChangeConfirm();
    const h = useCanvasHandoff({
      excalidrawAPI: api,
      hasLocalContent: () => true,
      requestSceneChangeDecision: c.requestSceneChangeDecision,
      cancelSceneChangeDialog: c.cancelSceneChangeDialog,
      setSceneChangeLoading: c.setSceneChangeDialogLoading,
      uploadSceneToCloud: upload,
      cancelPendingSceneSave: vi.fn(),
    });
    useEffect(() => {
      confirm = c;
      handoff = h;
    }, [c, h]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  let cancelled = false;
  const begin = () => {
    let joining!: ReturnType<typeof handoff.prepareCanvasForRoom>;
    act(() => {
      joining = handoff.prepareCanvasForRoom({
        isCancelled: () => cancelled,
        onDecisionPrompt: vi.fn(),
      });
    });
    return joining;
  };
  const joining = begin();
  return {
    upload,
    reset,
    joining,
    begin,
    get confirm() {
      return confirm;
    },
    choose: async (choice: "save" | "switch" | "cancel") => {
      await act(async () => {
        confirm.resolveSceneChangeDecision(choice);
        if (choice === "cancel")
          confirm.handleSceneChangeDialogOpenChange(false);
      });
    },
    stop: async () => {
      await act(async () => {
        cancelled = true;
        handoff.cancelPendingCanvasDecision();
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

function deferredSave() {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("saving before joining a room", () => {
  it("retries repeatedly and prepares the canvas only after saving succeeds", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await flow.choose("save");
      expect(flow.upload).toHaveBeenCalledTimes(2);
      expect(flow.reset).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(true);
      expect(flow.confirm.isSceneChangeDialogLoading).toBe(false);
      flow.upload.mockResolvedValueOnce(true);
      await flow.choose("save");
      expect(await flow.joining).toBe("prepared");
      expect(flow.reset).toHaveBeenCalledTimes(1);
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it("accepts discard after a rejected save", async () => {
    const flow = mountFlow();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      flow.upload.mockRejectedValueOnce(new Error("offline"));
      await flow.choose("save");
      expect(flow.reset).not.toHaveBeenCalled();
      await flow.choose("switch");
      expect(await flow.joining).toBe("prepared");
      expect(flow.upload).toHaveBeenCalledTimes(1);
      expect(flow.reset).toHaveBeenCalledTimes(1);
    } finally {
      flow.unmount();
    }
  });

  it("keeps the canvas when the user cancels after a failure", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await flow.choose("cancel");
      expect(await flow.joining).toBe("declined");
      expect(flow.reset).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it("ends the join if another dialog takes over after a failure", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await act(async () => flow.confirm.closeSceneChangeDialog());
      expect(await flow.joining).toBe("declined");
      expect(flow.reset).not.toHaveBeenCalled();
    } finally {
      flow.unmount();
    }
  });

  it("settles the re-armed choice on controller teardown", async () => {
    const flow = mountFlow();
    try {
      await flow.choose("save");
      await flow.stop();
      expect(await flow.joining).toBe("torn-down");
      expect(flow.reset).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
    } finally {
      flow.unmount();
    }
  });

  it.each([false, true])(
    "does not prepare after teardown during an upload returning %s",
    async (saved) => {
      const flow = mountFlow();
      const upload = deferredSave();
      try {
        flow.upload.mockReturnValueOnce(upload.promise);
        await flow.choose("save");
        expect(flow.confirm.isSceneChangeDialogLoading).toBe(true);
        await flow.stop();
        expect(flow.confirm.isSceneChangeDialogLoading).toBe(false);
        expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
        await act(async () => upload.resolve(saved));
        expect(await flow.joining).toBe("torn-down");
        expect(flow.reset).not.toHaveBeenCalled();
        expect(flow.upload).toHaveBeenCalledTimes(1);
      } finally {
        flow.unmount();
      }
    },
  );

  it("cancels a waiting retry on unmount", async () => {
    const flow = mountFlow();
    await flow.choose("save");
    flow.unmount();
    expect(await flow.joining).toBe("torn-down");
    expect(flow.reset).not.toHaveBeenCalled();
  });

  it("does not let an older upload close a newer confirmation", async () => {
    const flow = mountFlow();
    const upload = deferredSave();
    try {
      flow.upload.mockReturnValueOnce(upload.promise);
      await flow.choose("save");
      const newer = flow.begin();
      await act(async () => upload.resolve(true));
      expect(await flow.joining).toBe("torn-down");
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(true);
      expect(flow.reset).not.toHaveBeenCalled();
      await flow.choose("switch");
      expect(await newer).toBe("prepared");
      expect(flow.reset).toHaveBeenCalledTimes(1);
    } finally {
      flow.unmount();
    }
  });

  it("explains a busy save on a newer join and allows saving after it finishes", async () => {
    const flow = mountFlow();
    const upload = deferredSave();
    try {
      flow.upload.mockReturnValueOnce(upload.promise);
      await flow.choose("save");
      const newer = flow.begin();
      await flow.choose("save");
      expect(flow.upload).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith(
        "collaboration.saveStillInProgress",
      );
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(true);
      expect(flow.confirm.isSceneChangeDialogLoading).toBe(false);
      await act(async () => upload.resolve(true));
      expect(await flow.joining).toBe("torn-down");
      flow.upload.mockResolvedValueOnce(true);
      await flow.choose("save");
      expect(await newer).toBe("prepared");
      expect(flow.upload).toHaveBeenCalledTimes(2);
      expect(flow.reset).toHaveBeenCalledTimes(1);
    } finally {
      flow.unmount();
    }
  });

  it("guards external close during saving and accepts it after the save fails", async () => {
    const flow = mountFlow();
    const upload = deferredSave();
    let settled = false;
    void flow.joining.then(() => {
      settled = true;
    });
    try {
      flow.upload.mockReturnValueOnce(upload.promise);
      await flow.choose("save");
      await act(async () => flow.confirm.closeSceneChangeDialog());
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(true);
      expect(flow.confirm.isSceneChangeDialogLoading).toBe(true);
      expect(settled).toBe(false);
      await act(async () => upload.resolve(false));
      await act(async () => flow.confirm.closeSceneChangeDialog());
      expect(await flow.joining).toBe("declined");
      expect(flow.reset).not.toHaveBeenCalled();
      expect(flow.confirm.isSceneChangeDialogOpen).toBe(false);
      expect(flow.confirm.isSceneChangeDialogLoading).toBe(false);
    } finally {
      flow.unmount();
    }
  });
});
