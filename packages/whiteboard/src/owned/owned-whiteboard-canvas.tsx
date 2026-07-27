"use client";

import { useEffect, useRef } from "react";
import type {
  OwnedWhiteboardDocument,
  WhiteboardEngine,
  WhiteboardViewerController,
} from "../contracts";
import { recordWhiteboardDiagnostic } from "../diagnostics";
import { WHITEBOARD_DOCUMENT_VERSION } from "../canonical-document";
import { OwnedWhiteboardInput } from "./input";
import { OwnedWhiteboardRenderer } from "./renderer";
import { OwnedWhiteboardStore } from "./store";
import { OwnedWhiteboardTextEditor } from "./text-editor";
import {
  DEFAULT_OWNED_DRAWING_CAPABILITIES,
  type OwnedDrawingCapabilities,
} from "./drawing";

export interface OwnedWhiteboardCanvasProps {
  readonly document?:
    OwnedWhiteboardDocument | Promise<OwnedWhiteboardDocument | null> | null;
  readonly onEngineReady?: (engine: WhiteboardEngine | null) => void;
  readonly onViewerReady?: (
    controller: WhiteboardViewerController | null,
  ) => void;
  readonly onDocumentReady?: () => void;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly drawingCapabilities?: Partial<OwnedDrawingCapabilities>;
  readonly editingEnabled?: boolean;
}

type OwnedDocumentSource =
  | OwnedWhiteboardDocument
  | Promise<OwnedWhiteboardDocument | null>
  | null
  | undefined;

interface OwnedCanvasLifecycle {
  readonly store: OwnedWhiteboardStore;
  readonly input: OwnedWhiteboardInput;
  readonly renderer: OwnedWhiteboardRenderer;
  active: boolean;
  diagnosticsEnabled: boolean;
  fitOnResize: boolean;
  request: number;
  source: OwnedDocumentSource;
}

export function OwnedWhiteboardCanvas({
  document,
  onEngineReady,
  onViewerReady,
  onDocumentReady,
  className,
  ariaLabel = "Whiteboard canvas",
  drawingCapabilities,
  editingEnabled = true,
}: OwnedWhiteboardCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const storeRef = useRef<OwnedWhiteboardStore | null>(null);
  const documentRef = useRef<OwnedDocumentSource>(document);
  const drawingCapabilitiesRef = useRef<OwnedDrawingCapabilities>(
    DEFAULT_OWNED_DRAWING_CAPABILITIES,
  );
  const editingEnabledRef = useRef(editingEnabled);
  const lifecycleRef = useRef<OwnedCanvasLifecycle | null>(null);
  documentRef.current = document;
  drawingCapabilitiesRef.current = {
    ...DEFAULT_OWNED_DRAWING_CAPABILITIES,
    ...drawingCapabilities,
  };
  editingEnabledRef.current = editingEnabled;

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
    const readOnly = Boolean(onViewerReady);
    const inputEditingEnabled = editingEnabledRef.current && !readOnly;
    renderer.setEditingEnabled(inputEditingEnabled);
    const textEditor = new OwnedWhiteboardTextEditor(root, store);
    const interactionSink = {
      setMarquee: (bounds: Parameters<typeof renderer.setMarquee>[0]) =>
        renderer.setMarquee(bounds),
      setPreview: (element: Parameters<typeof renderer.setPreview>[0]) =>
        renderer.setPreview(element),
      beginTextEditing: (point: Parameters<typeof textEditor.begin>[0]) =>
        textEditor.begin(point),
    };
    const input = new OwnedWhiteboardInput(
      root,
      store,
      interactionSink,
      drawingCapabilitiesRef.current,
      undefined,
      inputEditingEnabled,
    );
    const lifecycle: OwnedCanvasLifecycle = {
      store,
      input,
      renderer,
      active: true,
      diagnosticsEnabled: !readOnly,
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
    applyDocument(lifecycle, documentRef.current, onDocumentReady);
    onEngineReady?.(store);
    onViewerReady?.(createViewerController(store));

    return () => {
      lifecycle.active = false;
      lifecycle.request += 1;
      unsubscribeDestroy();
      releaseEnvironment();
      input.destroy();
      textEditor.destroy();
      renderer.destroy();
      store.destroy();
      if (storeRef.current === store) storeRef.current = null;
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      onEngineReady?.(null);
      onViewerReady?.(null);
    };
  }, [onDocumentReady, onEngineReady, onViewerReady]);

  useEffect(() => {
    lifecycleRef.current?.input.setCapabilities(drawingCapabilitiesRef.current);
  }, [drawingCapabilities]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    const enabled = editingEnabledRef.current && !onViewerReady;
    lifecycle?.input.setEditingEnabled(enabled);
    lifecycle?.renderer.setEditingEnabled(enabled);
  }, [editingEnabled, onViewerReady]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || lifecycle.source === document) return;
    applyDocument(lifecycle, document, onDocumentReady);
  }, [document, onDocumentReady]);

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
  onDocumentReady?: () => void,
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
      if (lifecycle.diagnosticsEnabled) {
        recordWhiteboardDiagnostic({
          operation: "render",
          outcome: "success",
          documentVersion: WHITEBOARD_DOCUMENT_VERSION,
        });
      }
      if (!hasSavedViewport(document)) {
        const viewport = lifecycle.store.getViewport();
        if (viewport.width > 0 && viewport.height > 0) {
          lifecycle.store.fitToContent();
        } else {
          lifecycle.fitOnResize = true;
        }
      }
      onDocumentReady?.();
    })
    .catch((error: unknown) => {
      if (lifecycle.active && request === lifecycle.request) {
        console.error("Failed to load owned whiteboard document", error);
        if (lifecycle.diagnosticsEnabled) {
          recordWhiteboardDiagnostic({
            operation: "render",
            outcome: "failure",
            documentVersion:
              source && !(source instanceof Promise)
                ? WHITEBOARD_DOCUMENT_VERSION
                : null,
            errorCode: "INVALID_DOCUMENT",
          });
        }
      }
    });
}

function createViewerController(
  store: OwnedWhiteboardStore,
): WhiteboardViewerController {
  const controller: WhiteboardViewerController = {
    getViewport: () => store.getViewport(),
    subscribeViewport: (
      listener: Parameters<WhiteboardViewerController["subscribeViewport"]>[0],
    ) => {
      listener(store.getViewport());
      return store.subscribeEditorState((state) => listener(state.viewport));
    },
    updateViewport: (
      update: Parameters<WhiteboardViewerController["updateViewport"]>[0],
    ) => store.updateViewport(update),
    fitToContent: (
      options: Parameters<WhiteboardViewerController["fitToContent"]>[0],
    ) => store.fitToContent(options),
  };
  return Object.freeze(controller);
}

function hasSavedViewport(document: OwnedWhiteboardDocument): boolean {
  return (
    typeof document.state.scrollX === "number" &&
    Number.isFinite(document.state.scrollX) &&
    typeof document.state.scrollY === "number" &&
    Number.isFinite(document.state.scrollY)
  );
}
