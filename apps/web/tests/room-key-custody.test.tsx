// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";

const { roomKeyMutate, escrowMutate } = vi.hoisted(() => ({
  roomKeyMutate: vi.fn(),
  escrowMutate: vi.fn(),
}));
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({
      client: {
        collaborationAuthority: {
          roomKey: { mutate: roomKeyMutate },
          escrowRoomKey: { mutate: escrowMutate },
        },
      },
    }),
  },
}));

const { useRoomKeyCustody } =
  await import("@/hooks/excalidraw/use-room-key-custody");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA" as RoomKey;
const ROOM = "87f19732-2ffa-4fbe-8456-7c221487594f";
const probe: { settled?: boolean } = {};
const onRoomKeyChange = vi.fn();

function Probe(props: {
  roomKey: RoomKey | null;
  status: CollaborationRoomStatus;
  isAuthenticated?: boolean;
}) {
  probe.settled = useRoomKeyCustody({
    roomId: ROOM,
    roomKey: props.roomKey,
    status: props.status,
    isAuthenticated: props.isAuthenticated ?? true,
    onRoomKeyChange,
  }).lookupSettled;
  return null;
}

let root: Root;
let container: HTMLDivElement;
const render = async (
  roomKey: RoomKey | null,
  status: CollaborationRoomStatus,
  isAuthenticated = true,
) => {
  await act(async () => {
    root.render(
      <Probe
        roomKey={roomKey}
        status={status}
        isAuthenticated={isAuthenticated}
      />,
    );
  });
};

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  vi.clearAllMocks();
  escrowMutate.mockResolvedValue({ escrowed: true });
});
afterEach(() => act(() => root.unmount()));

describe("room key custody in the editor (plan 19)", () => {
  it("opens a keyless room with Room's custody copy, without the paste fallback", async () => {
    roomKeyMutate.mockResolvedValue({ roomKey: KEY, authGeneration: 1 });
    await render(null, "missing-room-key");
    expect(roomKeyMutate).toHaveBeenCalledOnce();
    expect(onRoomKeyChange).toHaveBeenCalledWith(KEY);
    // Until the room rejoins with that key it still reads as keyless; the
    // paste-link dialog must not open in that gap.
    expect(probe.settled).toBe(false);
    // A key that came from custody is not handed back.
    await render(KEY, "connected");
    expect(escrowMutate).not.toHaveBeenCalled();
  });

  it("falls back to the paste-link dialog once Room has no key", async () => {
    roomKeyMutate.mockResolvedValue(null);
    await render(null, "missing-room-key");
    expect(probe.settled).toBe(true);
    expect(onRoomKeyChange).not.toHaveBeenCalled();
    // Asked once per room, not on every render.
    await render(null, "missing-room-key");
    expect(roomKeyMutate).toHaveBeenCalledOnce();
  });

  it("hands a key from a joined link to Room once, so the room becomes reopenable", async () => {
    await render(KEY, "joining");
    expect(escrowMutate).not.toHaveBeenCalled();
    await render(KEY, "connected");
    await render(KEY, "connected");
    expect(escrowMutate).toHaveBeenCalledOnce();
    expect(escrowMutate).toHaveBeenCalledWith({ roomId: ROOM, roomKey: KEY });
  });

  it("asks again when an unanswered lookup was abandoned", async () => {
    let answer: (value: null) => void = () => undefined;
    roomKeyMutate.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await render(null, "missing-room-key");
    // Signed out before Room answered; the late answer is discarded.
    await render(null, "missing-room-key", false);
    await act(async () => answer(null));
    roomKeyMutate.mockResolvedValueOnce({ roomKey: KEY, authGeneration: 1 });
    await render(null, "missing-room-key", true);
    expect(roomKeyMutate).toHaveBeenCalledTimes(2);
    expect(onRoomKeyChange).toHaveBeenCalledWith(KEY);
  });
});
