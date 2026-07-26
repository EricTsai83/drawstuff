"use client";

import { useEffect, useRef } from "react";
import type {
  WhiteboardDocument,
  WhiteboardEngine,
} from "@/features/whiteboard/contracts";
import { OwnedWhiteboardInput } from "./input";
import { OwnedWhiteboardRenderer } from "./renderer";
import { OwnedWhiteboardStore } from "./store";

export interface OwnedWhiteboardCanvasProps {
  readonly document?:
    WhiteboardDocument | Promise<WhiteboardDocument | null> | null;
  readonly onEngineReady: (engine: WhiteboardEngine | null) => void;
  readonly className?: string;
  readonly ariaLabel?: string;
}

type OwnedDocumentSource =
  WhiteboardDocument | Promise<WhiteboardDocument | null> | null | undefined;

interface OwnedCanvasLifecycle {
  readonly store: OwnedWhiteboardStore;
  active: boolean;
  fitOnResize: boolean;
  request: number;
  source: OwnedDocumentSource;
}

export function OwnedWhiteboardCanvas({
  document,
  onEngineReady,
  className,
  ariaLabel = "Whiteboard canvas",
}: OwnedWhiteboardCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const storeRef = useRef<OwnedWhiteboardStore | null>(null);
  const documentRef = useRef<OwnedDocumentSource>(document);
  const lifecycleRef = useRef<OwnedCanvasLifecycle | null>(null);
  documentRef.current = document;

  useEffect(() => {
    const root = rootRef.current;
    const sceneCanvas = sceneCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!root || !sceneCanvas || !overlayCanvas) return;

    const store = new OwnedWhiteboardStore();
    const renderer = new OwnedWhiteboardRenderer(
      sceneCanvas,
      overlayCanvas,
      store,
    );
    const input = new OwnedWhiteboardInput(root, store, renderer);
    const lifecycle: OwnedCanvasLifecycle = {
      store,
      active: true,
      fitOnResize: false,
      request: 0,
      source: undefined,
    };
    lifecycleRef.current = lifecycle;
    const resize = (): void => {
      const bounds = root.getBoundingClientRect();
      const pixelRatio =
        typeof window.devicePixelRatio === "number"
          ? window.devicePixelRatio
          : 1;
      store.resizeViewport(
        bounds.width,
        bounds.height,
        bounds.left,
        bounds.top,
      );
      renderer.resize(bounds.width, bounds.height, pixelRatio);
      if (lifecycle.fitOnResize && bounds.width > 0 && bounds.height > 0) {
        lifecycle.fitOnResize = false;
        store.fitToContent();
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    let environmentReleased = false;
    const releaseEnvironment = (): void => {
      if (environmentReleased) return;
      environmentReleased = true;
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
    };
    const unsubscribeDestroy = store.subscribeDestroy(releaseEnvironment);
    resizeObserver.observe(root);
    window.addEventListener("resize", resize);
    resize();
    storeRef.current = store;
    applyDocument(lifecycle, documentRef.current);
    onEngineReady(store);

    return () => {
      lifecycle.active = false;
      lifecycle.request += 1;
      unsubscribeDestroy();
      releaseEnvironment();
      input.destroy();
      renderer.destroy();
      store.destroy();
      if (storeRef.current === store) storeRef.current = null;
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      onEngineReady(null);
    };
  }, [onEngineReady]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || lifecycle.source === document) return;
    applyDocument(lifecycle, document);
  }, [document]);

  return (
    <div
      ref={rootRef}
      role="application"
      aria-label={ariaLabel}
      className={`relative h-full w-full overflow-hidden outline-none ${className ?? ""}`}
      style={{ touchAction: "none" }}
      tabIndex={0}
    >
      <canvas
        ref={sceneCanvasRef}
        aria-hidden="true"
        className="absolute inset-0"
      />
      <canvas
        ref={overlayCanvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
      />
    </div>
  );
}

function applyDocument(
  lifecycle: OwnedCanvasLifecycle,
  source: OwnedDocumentSource,
): void {
  lifecycle.source = source;
  const request = ++lifecycle.request;
  if (!source) return;
  void Promise.resolve(source)
    .then((document) => {
      if (
        !document ||
        !lifecycle.active ||
        request !== lifecycle.request ||
        lifecycle.store.isDestroyed()
      ) {
        return;
      }
      lifecycle.store.loadDocument(document);
      if (!hasSavedViewport(document)) {
        const viewport = lifecycle.store.getViewport();
        if (viewport.width > 0 && viewport.height > 0) {
          lifecycle.store.fitToContent();
        } else {
          lifecycle.fitOnResize = true;
        }
      }
    })
    .catch((error: unknown) => {
      if (lifecycle.active && request === lifecycle.request) {
        console.error("Failed to load owned whiteboard document", error);
      }
    });
}

function hasSavedViewport(document: WhiteboardDocument): boolean {
  return (
    typeof document.state.scrollX === "number" &&
    Number.isFinite(document.state.scrollX) &&
    typeof document.state.scrollY === "number" &&
    Number.isFinite(document.state.scrollY)
  );
}
