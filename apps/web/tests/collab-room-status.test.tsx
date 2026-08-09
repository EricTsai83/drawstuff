import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The room status surface: what a session that is connected but not entirely
 * healthy tells the user, and how those facts rank against each other.
 *
 * Two conditions live here, and they are deliberately different in severity — an
 * oversize canvas that has stopped publishing (Plan 19 step 7) and a room holding
 * images this link cannot open (Plan 30). Neither ends the session, so neither
 * appears in the recovery state, and both would otherwise be invisible.
 *
 * Everything below the hook is mocked, because what is under test is the hook's
 * own reporting decisions: which status a blocked session presents, whether the
 * actionable message survives a reconnect, and what happens when a condition is
 * discovered during teardown, at which point there is no room UI left to show it
 * in. Driving that through a real relay would prove nothing extra — the session
 * side of the same behaviour is covered against the real codec in
 * `collab-oversize-sync.test.ts` and `collab-asset-transfer.test.ts`.
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

vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({
    langCode: "en",
    t: (key: string, values?: Record<string, string | number>) => {
      const translations: Record<string, string> = {
        "collaboration.status.connected": "Collaborating",
        "collaboration.status.idle": "Collaborate",
        "collaboration.status.readOnly": "View only",
        "collaboration.status.readOnlyWithStatus": "{status} (View only)",
        "collaboration.status.syncBlocked": "Sync stopped",
      };
      const template = translations[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
        String(values?.[name] ?? ""),
      );
    },
  }),
}));

import { TRPCClientError } from "@trpc/client";

import { sealRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  generateRoomKey,
  roomKeySchema,
} from "@drawstuff/collaboration/realtime-crypto";
import type { RecoveryState } from "@drawstuff/collaboration/recovery";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { CollaborationButton } from "@/components/excalidraw/collaboration-button";
import { SceneSessionProvider } from "@/hooks/scene-session-context";
import {
  MAX_INITIAL_JOIN_ATTEMPTS,
  useCollaborationRoom,
  type CollaborationRoomStatus,
  type UseCollaborationRoomResult,
} from "@/hooks/excalidraw/use-collaboration-room";
import type { SceneSyncBlock } from "@/lib/collab/collaboration-session";
import { readCanvasRoomId } from "@/lib/collab/canvas-room-marker";

const ROOM_ID = "room-oversize";
const ROOM_KEY = roomKeySchema.parse(
  "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
);

/** The room's stored key-check value, sealed for `ROOM_KEY` (Plan 34). */
let keyCheckBase64: string;

beforeAll(async () => {
  keyCheckBase64 = await sealRoomKeyCheck({
    roomKey: ROOM_KEY,
    roomId: roomIdSchema.parse(ROOM_ID),
    authGeneration: 1,
  });
});

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
  onAssetsUnreadable: () => void;
};

const probe: { result?: UseCollaborationRoomResult } = {};

/**
 * Module-level so its identity is stable: the hook's join effect keys on the
 * editor API, and a fresh object per render would tear the room down and rejoin
 * on every state change.
 */
const updateScene = vi.fn();
const clearCurrentScene = vi.fn();
const EXCALIDRAW_API = { updateScene } as unknown as ExcalidrawImperativeAPI;

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
    clearCurrentScene,
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

/**
 * The join now includes real Web Crypto work (the pre-join key check), whose
 * completion is a task, not a microtask — so a single `act` pass no longer
 * drains the whole join chain. Ticks the clock until the condition holds.
 */
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const renderProbe = async (): Promise<void> => {
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
};

/** Mounts the hook and returns the callbacks the session was started with. */
const mountRoom = async (): Promise<SessionCallbacks> => {
  await renderProbe();
  await waitFor(() => startRoomSession.mock.calls.length > 0);
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
  sessionStorage.clear();
  toastWarning.mockClear();
  startRoomSession.mockClear();
  joinMutate.mockClear();
  roomGetQuery.mockClear();
  updateScene.mockClear();
  clearCurrentScene.mockClear();
  startRoomSession.mockImplementation(() =>
    Promise.resolve({ destroy: () => Promise.resolve() }),
  );
  roomGetQuery.mockResolvedValue({
    roomId: ROOM_ID,
    sceneId: "scene-1",
    authGeneration: 1,
    keyCheckBase64,
  });
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

describe("room status for images this link cannot open", () => {
  it("says so without downgrading a session that is still syncing", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onAssetsUnreadable();
    });

    // The elements still sync and the socket is fine, so calling this anything
    // other than 共編中 would overstate it — the canvas is incomplete, not broken.
    expect(probe.result?.status).toBe("connected");
    expect(probe.result?.isCollaborating).toBe(true);
    expect(probe.result?.errorMessage).toContain("圖片無法用目前的連結開啟");
    // Layout-independent announcement, for the viewports that do not render the
    // status area at all.
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(String(toastWarning.mock.calls[0]?.[0])).toContain(
      "圖片無法用目前的連結開啟",
    );
  });

  it("lets the oversize warning outrank it", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onAssetsUnreadable();
      session.onSceneSyncBlockChange(OVERSIZE_REALTIME);
    });

    // Losing the user's own unpublished work is the more urgent of the two, and a
    // single message area cannot say both at once.
    expect(probe.result?.status).toBe("sync-blocked");
    expect(probe.result?.errorMessage).toContain("即時同步已停止");

    // Still true underneath, and it comes back once the canvas fits again.
    await act(async () => {
      session.onSceneSyncBlockChange(null);
    });
    expect(probe.result?.status).toBe("connected");
    expect(probe.result?.errorMessage).toContain("圖片無法用目前的連結開啟");
  });

  it("lets a terminal failure's own message outrank it", async () => {
    const session = await mountRoom();
    await act(async () => {
      session.onRecoveryStateChange({ phase: "live" });
      session.onAssetsUnreadable();
      session.onRecoveryStateChange({
        phase: "failed",
        reason: "unreadable-room",
      });
    });

    expect(probe.result?.status).toBe("failed");
    expect(probe.result?.errorMessage).toContain("無法用目前連結的金鑰解開");
    expect(probe.result?.errorMessage).not.toContain("其他內容仍在正常同步");
  });
});

describe("key check before join (Plan 34)", () => {
  /** Mounts the hook and waits for the join attempt to be refused. */
  const mountBlocked = async (): Promise<void> => {
    await renderProbe();
    await waitFor(() => probe.result?.status === "failed");
  };

  it("refuses a wrong-key link before the canvas is touched", async () => {
    roomGetQuery.mockResolvedValue({
      roomId: ROOM_ID,
      // Another scene, so a join that got past the check would have replaced
      // the canvas — the assertions below are that it never got the chance.
      sceneId: "scene-room",
      authGeneration: 1,
      keyCheckBase64: await sealRoomKeyCheck({
        roomKey: generateRoomKey(),
        roomId: roomIdSchema.parse(ROOM_ID),
        authGeneration: 1,
      }),
    });

    await mountBlocked();

    expect(probe.result?.status).toBe("failed");
    expect(probe.result?.failureReason).toBe("wrong-key-link");
    expect(probe.result?.errorMessage).toContain("金鑰不正確");
    expect(probe.result?.errorMessage).toContain("畫布沒有被變更");
    // Refused before the join: the canvas was not cleared, no claim was
    // taken, no token was minted and no session was started — which is what
    // makes a wrong-key snapshot write impossible (the empty-room cell of
    // Plan 30's table).
    expect(clearCurrentScene).not.toHaveBeenCalled();
    expect(updateScene).not.toHaveBeenCalled();
    expect(joinMutate).not.toHaveBeenCalled();
    expect(startRoomSession).not.toHaveBeenCalled();
    expect(probe.result?.ownsCanvas).toBe(false);
  });

  it("treats a room with no check value as unverifiable, not as trusted", async () => {
    roomGetQuery.mockResolvedValue({
      roomId: ROOM_ID,
      sceneId: "scene-room",
      authGeneration: 1,
      keyCheckBase64: null,
    });

    await mountBlocked();

    expect(probe.result?.status).toBe("failed");
    expect(probe.result?.failureReason).toBe("missing-key-check");
    expect(probe.result?.errorMessage).toContain("尚未完成加密設定");
    expect(joinMutate).not.toHaveBeenCalled();
    expect(startRoomSession).not.toHaveBeenCalled();
  });

  it("refuses a join that lands on a generation other than the verified one", async () => {
    // The rotate-while-in-the-prompt race: the check value was verified for
    // generation 1, but by the time the token is minted the room is at 2 —
    // this key was never verified for the generation the session would run
    // under, so the session must not start.
    joinMutate.mockResolvedValue({
      roomId: ROOM_ID,
      token: "join-token",
      authGeneration: 2,
      relayUrl: "ws://127.0.0.1:3105",
    });

    await renderProbe();
    await waitFor(() => probe.result?.status === "failed");

    expect(probe.result?.status).toBe("failed");
    expect(probe.result?.failureReason).toBe("generation-rotated");
    expect(probe.result?.errorMessage).toContain("加密世代已更新");
    expect(startRoomSession).not.toHaveBeenCalled();
  });

  it("lets the matching key through to the join", async () => {
    // The default mock stores a value sealed for ROOM_KEY: mountRoom itself
    // asserts the session started, so this pins that the gate passes the very
    // key it exists to verify.
    await mountRoom();
    expect(joinMutate).toHaveBeenCalledTimes(1);
    expect(startRoomSession).toHaveBeenCalledTimes(1);
    expect(probe.result?.failureReason).toBeNull();
  });

  it("claims the canvas after join succeeds but before the session can receive frames", async () => {
    startRoomSession.mockImplementationOnce(() => {
      expect(joinMutate).toHaveBeenCalledTimes(1);
      expect(readCanvasRoomId()).toBe(ROOM_ID);
      return Promise.resolve({ destroy: () => Promise.resolve() });
    });

    await mountRoom();
    expect(probe.result?.ownsCanvas).toBe(true);
  });

  it("releases the new claim when session construction fails", async () => {
    startRoomSession.mockRejectedValueOnce(new Error("session failed"));
    await renderProbe();
    await waitFor(() => probe.result?.status === "unauthorized");

    expect(joinMutate).toHaveBeenCalledTimes(1);
    expect(probe.result?.ownsCanvas).toBe(false);
    expect(readCanvasRoomId()).toBeNull();
  });

  it("re-runs the whole join, gate included, on retryJoin", async () => {
    // The owner's snapshot reset calls this instead of asking for a page
    // reload: the failed attempt is torn down through the effect's cleanup and
    // the join — key check and all — runs again.
    await mountRoom();
    expect(startRoomSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      probe.result?.retryJoin();
    });
    await waitFor(() => startRoomSession.mock.calls.length > 1);

    expect(startRoomSession).toHaveBeenCalledTimes(2);
    expect(joinMutate).toHaveBeenCalledTimes(2);
    expect(roomGetQuery).toHaveBeenCalledTimes(2);
  });
});

describe("the first join being rate limited", () => {
  /**
   * The bootstrap join is the one `classifyJoinFailure` never sees: there is no
   * session yet, so its failure used to land in the effect's catch-all and be
   * reported as `unauthorized` — terminal, and about the wrong thing. Being over
   * a shared budget says nothing about whether this client may be here.
   *
   * Driven through the real hook rather than the helper alone, because what
   * broke was the wiring: the helper can be perfect and still never be called.
   */
  const RETRY_AFTER_MS = 40_000;

  /** A refusal shaped exactly as `errorFormatter` puts it on the wire. */
  const rateLimited = (
    retryAfterMs: number = RETRY_AFTER_MS,
  ): TRPCClientError<never> => {
    const error = new TRPCClientError<never>(
      "Too many collaboration requests. Please retry shortly.",
    );
    Object.assign(error, {
      data: {
        code: "TOO_MANY_REQUESTS",
        rateLimit: { reset: 1_770_000_000_000, retryAfterMs },
      },
    });
    return error;
  };

  const withCode = (code: string): TRPCClientError<never> => {
    const error = new TRPCClientError<never>(code);
    Object.assign(error, { data: { code } });
    return error;
  };

  it("waits out one refusal and then joins, never reporting unauthorized", async () => {
    const seen: (string | undefined)[] = [];
    // A short deadline so this one runs on the real clock, end to end through
    // the hook: the timing itself is pinned separately below.
    joinMutate.mockRejectedValueOnce(rateLimited(5));
    await renderProbe();
    await waitFor(() => {
      seen.push(probe.result?.status);
      return startRoomSession.mock.calls.length > 0;
    });

    expect(joinMutate).toHaveBeenCalledTimes(2);
    expect(startRoomSession).toHaveBeenCalledTimes(1);
    // The status a user would have been shown at any point in between.
    expect(seen).not.toContain("unauthorized");
  });

  it("does not re-join before the server's stated reset", async () => {
    vi.useFakeTimers();
    try {
      joinMutate.mockRejectedValueOnce(rateLimited());
      await renderProbe();
      // Drain the join chain up to the wait without letting the clock move.
      for (let tick = 0; tick < 20; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      expect(joinMutate).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
      });
      expect(joinMutate).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(joinMutate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after a bounded number of attempts, as rate-limited not unauthorized", async () => {
    joinMutate.mockRejectedValue(rateLimited());
    vi.useFakeTimers();
    try {
      await renderProbe();
      for (let round = 0; round < 6; round += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
        });
      }
      expect(joinMutate).toHaveBeenCalledTimes(MAX_INITIAL_JOIN_ATTEMPTS);
      expect(startRoomSession).not.toHaveBeenCalled();
      // The whole point: a spent budget is "later", not "you may not".
      expect(probe.result?.status).toBe("rate-limited");
      expect(probe.result?.status).not.toBe("unauthorized");
      expect(probe.result?.errorMessage).toContain("不是權限問題");
      // `failureReason` belongs to the recovery machine's terminal states, and
      // this never reached a session.
      expect(probe.result?.failureReason).toBeNull();
      expect(probe.result?.ownsCanvas).toBe(false);
      expect(readCanvasRoomId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues no further join once the component is torn down mid-wait", async () => {
    joinMutate.mockRejectedValue(rateLimited());
    vi.useFakeTimers();
    try {
      await renderProbe();
      for (let tick = 0; tick < 20; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      expect(joinMutate).toHaveBeenCalledTimes(1);

      unmountRoom();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 4);
      });
      // The wait is released rather than left pending, so the loop resumes,
      // sees the teardown and stops — no request, and no state written into an
      // unmounted tree.
      expect(joinMutate).toHaveBeenCalledTimes(1);
      expect(startRoomSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports a genuine refusal as unauthorized, with no retry", async () => {
    // The guard on the whole change: only a machine-readable rate limit is
    // retried. An authorization failure must not become a loop, and must not be
    // softened into "try later".
    joinMutate.mockRejectedValue(withCode("FORBIDDEN"));
    await renderProbe();
    await waitFor(() => probe.result?.status === "unauthorized");

    expect(joinMutate).toHaveBeenCalledTimes(1);
    expect(probe.result?.status).toBe("unauthorized");
    expect(startRoomSession).not.toHaveBeenCalled();
    expect(probe.result?.ownsCanvas).toBe(false);
    expect(readCanvasRoomId()).toBeNull();
  });

  it("does not retry an ordinary failure that carries no deadline", async () => {
    joinMutate.mockRejectedValue(new Error("offline"));
    await renderProbe();
    await waitFor(() => probe.result?.status === "unauthorized");

    expect(joinMutate).toHaveBeenCalledTimes(1);
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
    expect(rendered.visible).toContain("View only");
    expect(rendered.accessibleName).toBe("View only");
  });

  it("shows the stopped-sync label even for a read-only session", () => {
    // A demoted editor: the block was latched before the role change and survives
    // the reconnect the change forces, so this session holds work it can never
    // publish. "僅檢視" alone would understate that.
    const rendered = renderButton({ status: "sync-blocked", isReadOnly: true });
    expect(rendered.visible).toContain("Sync stopped");
    expect(rendered.visible).not.toContain("Collaborating");
    // `aria-label` replaces the content and the icon carries no text, so the
    // accessible name has to state both facts or read-only is lost entirely.
    expect(rendered.accessibleName).toContain("Sync stopped");
    expect(rendered.accessibleName).toContain("View only");
  });

  it("uses the active language for the idle label", () => {
    const rendered = renderButton({ status: "idle", isReadOnly: false });
    expect(rendered.visible).toContain("Collaborate");
    expect(rendered.visible).not.toContain("共編");
  });
});
