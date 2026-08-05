import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The room status surface for an oversize canvas (Plan 19 step 7).
 *
 * Everything below the hook is mocked, because what is under test is the hook's
 * own reporting decisions: which status a blocked session presents, whether the
 * actionable message survives a reconnect, and what happens when the block is
 * discovered during teardown, at which point there is no room UI left to show it
 * in. Driving that through a real relay would prove nothing extra — the session
 * side of the same behaviour is covered against the real codec in
 * `collab-oversize-sync.test.ts`.
 */
// Hoisted: `vi.mock` factories run before module-level initialization.
const { toastWarning, startRoomSession, joinMutate, roomGetQuery } = vi.hoisted(
  () => ({
    toastWarning: vi.fn(),
    startRoomSession: vi.fn(),
    joinMutate: vi.fn(),
    roomGetQuery: vi.fn(),
  }),
);

vi.mock("sonner", () => ({ toast: { warning: toastWarning } }));

vi.mock("@/lib/collab/room-session", () => ({
  startCollaborationRoomSession: (options: unknown) =>
    startRoomSession(options),
  toCollaborationUsername: () => "tester",
}));

vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({
      client: {
        collaborationRoom: {
          get: { query: roomGetQuery },
          join: { mutate: joinMutate },
        },
        collaborationSnapshot: {
          get: { query: vi.fn() },
          put: { mutate: vi.fn() },
        },
        collaborationAsset: { resolve: { query: vi.fn() } },
      },
    }),
  },
}));

import { roomKeySchema } from "@drawstuff/collaboration/realtime-crypto";
import type { RecoveryState } from "@drawstuff/collaboration/recovery";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { CollaborationButton } from "@/components/excalidraw/collaboration-button";
import { SceneSessionProvider } from "@/hooks/scene-session-context";
import {
  useCollaborationRoom,
  type CollaborationRoomStatus,
  type UseCollaborationRoomResult,
} from "@/hooks/excalidraw/use-collaboration-room";
import type { SceneSyncBlock } from "@/lib/collab/collaboration-session";

const ROOM_ID = "room-oversize";
const ROOM_KEY = roomKeySchema.parse(
  "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
);

const OVERSIZE_REALTIME: SceneSyncBlock = {
  realtime: { byteLength: 2_200_000, maxByteLength: 1_048_576 },
  durable: null,
};

const OVERSIZE_DURABLE: SceneSyncBlock = {
  realtime: null,
  durable: { byteLength: 5_000_000, maxByteLength: 4_194_304 },
};

/** Callbacks the hook handed to the (mocked) room session. */
type SessionCallbacks = {
  onSceneSyncBlockChange: (block: SceneSyncBlock | null) => void;
  onRecoveryStateChange: (state: RecoveryState) => void;
};

const probe: { result?: UseCollaborationRoomResult } = {};

/**
 * Module-level so its identity is stable: the hook's join effect keys on the
 * editor API, and a fresh object per render would tear the room down and rejoin
 * on every state change.
 */
const EXCALIDRAW_API = {} as ExcalidrawImperativeAPI;

function Probe() {
  const result = useCollaborationRoom({
    excalidrawAPI: EXCALIDRAW_API,
    roomId: ROOM_ID,
    roomKey: ROOM_KEY,
    currentSceneId: "scene-1",
    username: "tester",
    isAuthenticated: true,
    hasLocalContent: () => false,
    requestSceneChangeDecision: () => Promise.resolve("switch" as const),
    closeSceneChangeConfirm: () => undefined,
    uploadSceneToCloud: () => Promise.resolve(true),
    clearCurrentScene: () => undefined,
  });
  useEffect(() => {
    probe.result = result;
  }, [result]);
  return null;
}

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

/**
 * The join is asynchronous (room lookup, then token mint), so these tests need
 * the async form of `act`, which React only supports when this flag is set.
 */
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts the hook and returns the callbacks the session was started with. */
const mountRoom = async (): Promise<SessionCallbacks> => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SceneSessionProvider>
        <Probe />
      </SceneSessionProvider>,
    );
  });
  const started = startRoomSession.mock.calls[0]?.[0] as
    SessionCallbacks | undefined;
  if (!started) throw new Error("room session was never started");
  return started;
};

const unmountRoom = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
};

beforeEach(() => {
  toastWarning.mockClear();
  startRoomSession.mockClear();
  startRoomSession.mockImplementation(() =>
    Promise.resolve({ destroy: () => Promise.resolve() }),
  );
  roomGetQuery.mockResolvedValue({ roomId: ROOM_ID, sceneId: "scene-1" });
  joinMutate.mockResolvedValue({
    roomId: ROOM_ID,
    token: "join-token",
    authGeneration: 1,
    relayUrl: "ws://127.0.0.1:3105",
  });
  probe.result = undefined;
});

afterEach(() => {
  if (root) unmountRoom();
  probe.result = undefined;
});

describe("room status for an oversize canvas", () => {
  it("stops presenting a blocked session as 共編中", async () => {
    const session = await mountRoom();

    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
    });
    expect(probe.result?.status).toBe("connected");

    await act(async () => {
      session.onSceneSyncBlockChange(OVERSIZE_REALTIME);
    });

    expect(probe.result?.status).toBe("sync-blocked");
    expect(probe.result?.errorMessage).toContain("即時同步已停止");
    expect(probe.result?.errorMessage).toContain("本機");
    // The canvas still belongs to the room, so the editor must keep withholding
    // the actions that would replace it behind the session's back.
    expect(probe.result?.isCollaborating).toBe(true);
    expect(probe.result?.ownsCanvas).toBe(true);
  });

  it("announces a live block on a layout-independent surface", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onSceneSyncBlockChange(OVERSIZE_REALTIME);
    });

    // The `sync-blocked` status lives in the top-right controls, which the editor
    // does not render on mobile (and hides between 728px and 1071px), so the
    // status alone would tell those viewports nothing. Upstream splits the same
    // way: a viewport-independent dialog plus a desktop-only indicator.
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(String(toastWarning.mock.calls[0]?.[0])).toContain("即時同步已停止");

    // One announcement per *reported transition*. The hook announces whatever it
    // is told, so what keeps a blocked canvas from announcing once per flush is
    // the session only reporting changes of state — covered against the real codec
    // by "announces the block once, not once per flush" in
    // `collab-oversize-sync.test.ts`.
    await act(async () => {
      session.onSceneSyncBlockChange(null);
    });
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it("keeps the size warning visible across a reconnect window", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onSceneSyncBlockChange(OVERSIZE_DURABLE);
    });
    expect(probe.result?.status).toBe("sync-blocked");

    // A transient drop: the connection status becomes the more urgent fact, but
    // the canvas is still too large and "export locally" is still the advice.
    await act(async () => {
      session.onRecoveryStateChange({
        phase: "waiting",
        attempt: 1,
        delayMs: 500,
      });
    });
    expect(probe.result?.status).toBe("reconnecting");
    expect(probe.result?.errorMessage).toContain("雲端備份已停止");

    // Back online with the same oversize canvas: blocked again, not "共編中".
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
    });
    expect(probe.result?.status).toBe("sync-blocked");
  });

  it("lets a terminal failure's own message outrank the size warning", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onSceneSyncBlockChange(OVERSIZE_REALTIME);
      session.onRecoveryStateChange({ phase: "failed", reason: "room-ended" });
    });

    expect(probe.result?.status).toBe("failed");
    expect(probe.result?.errorMessage).toContain("已被擁有者結束");
    expect(probe.result?.errorMessage).not.toContain("即時同步已停止");
  });

  it("clears the warning once every path publishes again", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onSceneSyncBlockChange(OVERSIZE_REALTIME);
    });
    expect(probe.result?.status).toBe("sync-blocked");

    await act(async () => {
      session.onSceneSyncBlockChange(null);
    });
    expect(probe.result?.status).toBe("connected");
    expect(probe.result?.errorMessage).toBeNull();
  });

  it("reports a block discovered during teardown, when no status surface is left", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
    });

    // The leave flush is asynchronous, so its refusal always lands after the
    // effect has been cancelled — for a canvas that only ever breached the
    // snapshot budget it is also the *first* refusal, so dropping it would make
    // the durable path silent exactly where the last copy of the work is at risk.
    unmountRoom();
    session.onSceneSyncBlockChange(OVERSIZE_DURABLE);

    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(String(toastWarning.mock.calls[0]?.[0])).toContain("雲端備份已停止");
  });

  it("does not announce a block that cleared during teardown", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
    });

    unmountRoom();
    session.onSceneSyncBlockChange(null);

    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe("collaboration button label", () => {
  /** Visible text and accessible name, which deliberately differ. */
  const renderButton = (props: {
    status: CollaborationRoomStatus;
    isReadOnly: boolean;
  }): { visible: string; accessibleName: string } => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const buttonRoot = createRoot(host);
    act(() => {
      buttonRoot.render(
        <CollaborationButton {...props} onClick={() => undefined} />,
      );
    });
    const rendered = {
      visible: host.textContent ?? "",
      accessibleName:
        host.querySelector("button")?.getAttribute("aria-label") ?? "",
    };
    act(() => {
      buttonRoot.unmount();
    });
    host.remove();
    return rendered;
  };

  it("keeps the read-only badge for an ordinary viewer", () => {
    const rendered = renderButton({ status: "connected", isReadOnly: true });
    expect(rendered.visible).toContain("僅檢視");
    expect(rendered.accessibleName).toBe("僅檢視");
  });

  it("shows the stopped-sync label even for a read-only session", () => {
    // A demoted editor: the block was latched before the role change and survives
    // the reconnect the change forces, so this session holds work it can never
    // publish. "僅檢視" alone would understate that.
    const rendered = renderButton({ status: "sync-blocked", isReadOnly: true });
    expect(rendered.visible).toContain("同步已停止");
    expect(rendered.visible).not.toContain("共編中");
    // `aria-label` replaces the content and the icon carries no text, so the
    // accessible name has to state both facts or read-only is lost entirely.
    expect(rendered.accessibleName).toContain("同步已停止");
    expect(rendered.accessibleName).toContain("僅檢視");
  });
});
