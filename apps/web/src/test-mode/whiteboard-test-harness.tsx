"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  OwnedWhiteboardCanvas,
  OwnedWhiteboardStore,
  type WhiteboardEngine,
  type WhiteboardPerformanceSample,
} from "@drawstuff/whiteboard";
import { WhiteboardShell } from "@/features/whiteboard/ui";
import {
  createWhiteboardTestFixture,
  type WhiteboardTestFixtureName,
} from "./whiteboard-fixtures";

declare global {
  interface Window {
    __DRAWSTUFF_WHITEBOARD_TEST__?: {
      readonly interactiveReadyTimestamp: number;
      readonly snapshot: () => {
        readonly documentEvents: number;
        readonly editorEvents: number;
        readonly historyCount: number;
        readonly performanceSamples: readonly WhiteboardPerformanceSample[];
        readonly store: ReturnType<OwnedWhiteboardStore["getIndexDiagnostics"]>;
      };
    };
  }
}

export function WhiteboardTestHarness({
  fixture,
  theme,
}: {
  readonly fixture: WhiteboardTestFixtureName;
  readonly theme: "light" | "dark";
}) {
  const boardDocument = useMemo(
    () => createWhiteboardTestFixture(fixture, theme),
    [fixture, theme],
  );
  const [engine, setEngine] = useState<WhiteboardEngine | null>(null);
  const engineRef = useRef<OwnedWhiteboardStore | null>(null);
  const counters = useRef({ document: 0, editor: 0 });
  const readyBaseline = useRef({ document: 0, editor: 0 });
  const performanceSamples = useRef<WhiteboardPerformanceSample[]>([]);
  const cleanup = useRef<readonly (() => void)[]>([]);

  const handleEngineReady = useCallback((next: WhiteboardEngine | null) => {
    for (const unsubscribe of cleanup.current) unsubscribe();
    cleanup.current = [];
    setEngine(next);
    const store = next instanceof OwnedWhiteboardStore ? next : null;
    engineRef.current = store;
    if (!store) return;
    counters.current = { document: 0, editor: 0 };
    cleanup.current = [
      store.subscribeDocument(() => {
        counters.current.document += 1;
      }),
      store.subscribeEditorState(() => {
        counters.current.editor += 1;
      }),
    ];
  }, []);

  const handleReady = useCallback(() => {
    const store = engineRef.current;
    if (!store) return;
    const readyAt = performance.now();
    readyBaseline.current = { ...counters.current };
    window.__DRAWSTUFF_WHITEBOARD_TEST__ = {
      interactiveReadyTimestamp: readyAt,
      snapshot: () => ({
        documentEvents:
          counters.current.document - readyBaseline.current.document,
        editorEvents: counters.current.editor - readyBaseline.current.editor,
        historyCount: store.getHistoryDiagnostics().undoEntries,
        performanceSamples: performanceSamples.current,
        store: store.getIndexDiagnostics(),
      }),
    };
    document.documentElement.dataset.whiteboardReady = "true";
  }, []);

  return (
    <main className="h-dvh w-full">
      <WhiteboardShell
        engine={engine}
        onRename={() => undefined}
        onSave={() => undefined}
        onShare={() => undefined}
        sceneName={`Test: ${fixture}`}
      >
        <OwnedWhiteboardCanvas
          document={boardDocument}
          onDocumentReady={handleReady}
          onEngineReady={handleEngineReady}
          onPerformanceSample={(sample) =>
            performanceSamples.current.push(sample)
          }
        />
      </WhiteboardShell>
    </main>
  );
}
