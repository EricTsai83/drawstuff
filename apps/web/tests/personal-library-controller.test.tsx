// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

const { useExcalidrawLibraryMock, getQuery, putMutate } = vi.hoisted(() => ({
  useExcalidrawLibraryMock: vi.fn(),
  getQuery: vi.fn(),
  putMutate: vi.fn(),
}));

vi.mock("@drawstuff/excalidraw-adapter/client", () => ({
  useExcalidrawLibrary: useExcalidrawLibraryMock,
}));

vi.mock("@/trpc/client", () => ({
  getTrpcClient: () => ({
    personalLibrary: {
      get: { query: getQuery },
      put: { mutate: putMutate },
    },
  }),
}));

import { PersonalLibraryController } from "@/components/excalidraw/personal-library-controller";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useExcalidrawLibraryMock.mockReset();
  getQuery.mockReset();
  putMutate.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PersonalLibraryController auth transitions", () => {
  it("clears memory before mounting each account's persistence listener", async () => {
    const resetResolvers: Array<() => void> = [];
    const updateLibrary = vi.fn(
      () =>
        new Promise<readonly []>((resolve) => {
          resetResolvers.push(() => resolve([]));
        }),
    );
    const excalidrawAPI = {
      updateLibrary,
    } as unknown as ExcalidrawImperativeAPI;
    const onStatusChange = vi.fn();
    const onReady = vi.fn();

    await act(async () => {
      root.render(
        <PersonalLibraryController
          key="user-a"
          excalidrawAPI={excalidrawAPI}
          userId="user-a"
          isAuthenticationPending={false}
          onStatusChange={onStatusChange}
          onReady={onReady}
        />,
      );
    });
    expect(updateLibrary).toHaveBeenCalledTimes(1);
    expect(useExcalidrawLibraryMock).not.toHaveBeenCalled();

    await act(async () => resetResolvers[0]?.());
    expect(useExcalidrawLibraryMock).toHaveBeenCalledTimes(1);
    expect(useExcalidrawLibraryMock.mock.calls[0]?.[0].adapter).toBeDefined();

    await act(async () => {
      root.render(
        <PersonalLibraryController
          key="user-b"
          excalidrawAPI={excalidrawAPI}
          userId="user-b"
          isAuthenticationPending={false}
          onStatusChange={onStatusChange}
          onReady={onReady}
        />,
      );
    });
    expect(updateLibrary).toHaveBeenCalledTimes(2);
    expect(useExcalidrawLibraryMock).toHaveBeenCalledTimes(1);

    await act(async () => resetResolvers[1]?.());
    expect(useExcalidrawLibraryMock).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("mounts session-only Library behavior for anonymous users", async () => {
    const excalidrawAPI = {
      updateLibrary: vi.fn(async () => []),
    } as unknown as ExcalidrawImperativeAPI;
    const onStatusChange = vi.fn();

    await act(async () => {
      root.render(
        <PersonalLibraryController
          excalidrawAPI={excalidrawAPI}
          userId={null}
          isAuthenticationPending={false}
          onStatusChange={onStatusChange}
          onReady={() => undefined}
        />,
      );
    });

    expect(useExcalidrawLibraryMock.mock.calls[0]?.[0].adapter).toBeUndefined();
    expect(onStatusChange).toHaveBeenCalledWith("anonymous");
  });

  it("does not mount persistence when clearing engine memory fails", async () => {
    const excalidrawAPI = {
      updateLibrary: vi.fn(async () => {
        throw new Error("reset failed");
      }),
    } as unknown as ExcalidrawImperativeAPI;
    const onStatusChange = vi.fn();

    await act(async () => {
      root.render(
        <PersonalLibraryController
          excalidrawAPI={excalidrawAPI}
          userId="user-a"
          isAuthenticationPending={false}
          onStatusChange={onStatusChange}
          onReady={() => undefined}
        />,
      );
    });

    expect(useExcalidrawLibraryMock).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenLastCalledWith("error");
  });
});
