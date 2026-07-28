"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createWhiteboardSessionStateV1,
  type WhiteboardEngine,
  type WhiteboardSessionStateV1,
} from "@drawstuff/whiteboard";
import {
  loadWhiteboardSessionState,
  saveWhiteboardSessionState,
} from "@/data/local-storage";

const SESSION_DEBOUNCE_MS = 100;

export function useWhiteboardSessionState(
  engine: WhiteboardEngine | null,
  sceneId: string | undefined,
): {
  readonly openPanel: string | null;
  readonly setOpenPanel: (panel: string | null) => void;
} {
  const stateRef = useRef<WhiteboardSessionStateV1>(
    createWhiteboardSessionStateV1(),
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [openPanel, setOpenPanelState] = useState<string | null>(null);

  const queueSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      saveWhiteboardSessionState(stateRef.current);
    }, SESSION_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    if (!engine) return;
    const session = loadWhiteboardSessionState();
    stateRef.current = session;
    setOpenPanelState(session.openPanel);
    engine.setActiveTool({
      type: session.activeTool,
      locked: session.toolLocked,
    });
    engine.updateElementStyle(session.lastUsedStyle);
    engine.updateViewport(
      sceneId
        ? (session.sceneViewports[sceneId] ?? session.viewport)
        : session.viewport,
    );
    return engine.subscribeEditorState((editor) => {
      const viewport = editor.viewport;
      stateRef.current = {
        ...stateRef.current,
        viewport: sceneId ? stateRef.current.viewport : viewport,
        activeTool: editor.activeTool.type,
        toolLocked: editor.toolLocked,
        lastUsedStyle: editor.elementStyle,
        sceneViewports: sceneId
          ? { ...stateRef.current.sceneViewports, [sceneId]: viewport }
          : stateRef.current.sceneViewports,
      };
      queueSave();
    });
  }, [engine, queueSave, sceneId]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      saveWhiteboardSessionState(stateRef.current);
    },
    [],
  );

  const setOpenPanel = useCallback(
    (panel: string | null) => {
      setOpenPanelState(panel);
      stateRef.current = { ...stateRef.current, openPanel: panel };
      queueSave();
    },
    [queueSave],
  );

  return { openPanel, setOpenPanel };
}

export function restoreWhiteboardSceneViewport(
  engine: WhiteboardEngine,
  sceneId: string,
): void {
  const session = loadWhiteboardSessionState();
  const viewport = session.sceneViewports[sceneId];
  if (viewport) engine.updateViewport(viewport);
}
