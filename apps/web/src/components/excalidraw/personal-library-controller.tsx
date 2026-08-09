"use client";

import { useExcalidrawLibrary } from "@drawstuff/excalidraw-adapter/library";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  createPersonalLibraryPersistenceAdapter,
  type PersonalLibrarySyncStatus,
} from "@/lib/personal-library-adapter";
import { getTrpcClient } from "@/trpc/client";

type Props = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  userId: string | null;
  isAuthenticationPending: boolean;
  onStatusChange: (status: PersonalLibrarySyncStatus) => void;
  onReady: () => void;
};

export function PersonalLibraryController({
  excalidrawAPI,
  userId,
  isAuthenticationPending,
  onStatusChange,
  onReady,
}: Props) {
  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;
  const readyCallbackRef = useRef(onReady);
  readyCallbackRef.current = onReady;
  const resetApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [isMemoryReset, setIsMemoryReset] = useState(false);

  const adapter = useMemo(() => {
    if (!userId || isAuthenticationPending) return undefined;
    const client = getTrpcClient();
    return createPersonalLibraryPersistenceAdapter({
      api: {
        get: () => client.personalLibrary.get.query(),
        put: (input) => client.personalLibrary.put.mutate(input),
      },
      onStatus: (status) => statusCallbackRef.current(status),
    });
  }, [isAuthenticationPending, userId]);

  useEffect(() => {
    onStatusChange(
      isAuthenticationPending
        ? "checking-auth"
        : userId
          ? "loading"
          : "anonymous",
    );
  }, [isAuthenticationPending, onStatusChange, userId]);

  useEffect(() => {
    if (!excalidrawAPI) return;
    let active = true;
    void excalidrawAPI
      .updateLibrary({ libraryItems: [], merge: false })
      .then(() => {
        if (!active) return;
        resetApiRef.current = excalidrawAPI;
        readyCallbackRef.current();
        setIsMemoryReset(true);
      })
      .catch(() => {
        if (active) statusCallbackRef.current("error");
      });
    return () => {
      active = false;
    };
  }, [excalidrawAPI]);

  return isMemoryReset && resetApiRef.current === excalidrawAPI ? (
    <PersonalLibraryRuntime
      excalidrawAPI={excalidrawAPI}
      adapter={adapter}
      onInstallError={() => statusCallbackRef.current("error")}
    />
  ) : null;
}

function PersonalLibraryRuntime({
  excalidrawAPI,
  adapter,
  onInstallError,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  adapter:
    ReturnType<typeof createPersonalLibraryPersistenceAdapter> | undefined;
  onInstallError: () => void;
}) {
  useExcalidrawLibrary({
    excalidrawAPI,
    adapter,
    resetOnMount: false,
    onInstallError,
  });
  return null;
}
