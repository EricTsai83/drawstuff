import { restoreScene } from "@drawstuff/excalidraw-adapter/client";
import {
  ensureInitialAppState,
  parseDrawstuffDocument,
  toNativeExcalidrawScene,
} from "@drawstuff/excalidraw-adapter/codec";
import type {
  AppState,
  ExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

type DecodedPersistedScene = {
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
};

/**
 * The single restore boundary for persisted scenes.
 *
 * The document codec is server-safe, so it hands element payloads back
 * verbatim — rows written by pre-V4 writers still lack native fields
 * (`groupIds`, `seed`, `versionNonce`, `boundElements`, `updated`, `link`,
 * `roundness`, `index`, `frameId`). Upstream reads several of them unguarded
 * (e.g. `element.groupIds.length` in its render/group/z-index code), so any
 * consumer that passes decoded elements to `excalidrawAPI.updateScene` crashes.
 * Restoring here means every persisted read — owned scene, shared link and
 * published page alike — yields native elements.
 *
 * Freedraw `pressures`/`simulatePressure` are NOT restored by upstream (its
 * SVG export reads `pressures[i]` unguarded and silently drops the stroke).
 * Stored rows were backfilled before this reader became the only supported path;
 * a round-trip tripwire in excalidraw-persisted-scene-restore.test.ts keeps
 * the writer from ever stripping the pair again.
 *
 * Only elements are restored: `restoreAppState` materialises every default,
 * including `scrollX`/`scrollY`/`zoom`, which would defeat the "did the saved
 * scene carry a viewport?" checks that decide whether to auto-center.
 */
export function decodePersistedScene(
  data: Uint8Array | undefined,
): DecodedPersistedScene {
  if (!data) {
    throw new Error("Persisted scene payload is empty");
  }
  const document = parseDrawstuffDocument(new TextDecoder().decode(data));
  const native = toNativeExcalidrawScene(document);
  const restored = restoreScene({ elements: native.elements }, null, null, {
    repairBindings: true,
    refreshDimensions: false,
  });

  return {
    elements: [...restored.elements],
    appState: ensureInitialAppState(native.appState),
  };
}
