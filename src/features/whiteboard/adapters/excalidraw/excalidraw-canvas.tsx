"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WhiteboardEngine } from "@/features/whiteboard";
import {
  toExcalidrawInitialData,
  type WhiteboardInitialData,
} from "./conversions";
import {
  createExcalidrawAdapterDelegates,
  ExcalidrawEngineAdapter,
} from "./excalidraw-engine-adapter";

export type ExcalidrawCanvasProps = Omit<
  ExcalidrawProps,
  "excalidrawAPI" | "initialData" | "onChange"
> & {
  readonly initialData?:
    WhiteboardInitialData | Promise<WhiteboardInitialData | null> | null;
  readonly onEngineReady: (engine: WhiteboardEngine | null) => void;
};

export function ExcalidrawCanvas({
  initialData,
  onEngineReady,
  ...props
}: ExcalidrawCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<ExcalidrawEngineAdapter | null>(null);
  const lifecycleRef = useRef(0);

  const convertedInitialData = useMemo(() => {
    if (!initialData) return null;
    if (initialData instanceof Promise) {
      return initialData.then((document) =>
        document ? toExcalidrawInitialData(document) : null,
      );
    }
    return toExcalidrawInitialData(initialData);
  }, [initialData]);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      adapterRef.current?.destroy();
      const adapter = new ExcalidrawEngineAdapter(
        api,
        createExcalidrawAdapterDelegates(
          () => rootRef.current?.querySelector(".excalidraw-container") ?? null,
        ),
      );
      adapterRef.current = adapter;
      onEngineReady(adapter);
    },
    [onEngineReady],
  );

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    const adapter = adapterRef.current;
    if (adapter) {
      onEngineReady(adapter);
    }

    return () => {
      const currentAdapter = adapterRef.current;
      onEngineReady(null);
      queueMicrotask(() => {
        if (
          // Deliberately read the latest generation after Strict Mode's
          // cleanup/setup replay before releasing the shared adapter.
          // eslint-disable-next-line react-hooks/exhaustive-deps
          lifecycleRef.current !== lifecycle ||
          adapterRef.current !== currentAdapter
        ) {
          return;
        }
        currentAdapter?.destroy();
        adapterRef.current = null;
      });
    };
  }, [onEngineReady]);

  return (
    <div ref={rootRef} className="h-full w-full">
      <Excalidraw
        {...props}
        initialData={convertedInitialData}
        excalidrawAPI={handleApi}
      />
    </div>
  );
}
