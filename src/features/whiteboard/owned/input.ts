import {
  elementsInBounds,
  hitTestElements,
  normalizeBounds,
  screenToDocument,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";
import {
  beginOwnedDrawing,
  createOwnedDrawingElement,
  createOwnedElementId,
  DEFAULT_OWNED_DRAWING_CAPABILITIES,
  isOwnedCreatableTool,
  updateOwnedDrawing,
  type OwnedDrawingCapabilities,
  type OwnedDrawingSession,
} from "./drawing";
import type { WhiteboardElement } from "@/features/whiteboard/contracts";
import type { OwnedWhiteboardStore } from "./store";
import {
  getResizedBounds,
  getSelectionBounds,
  getTransformHandleAt,
  resizeElements,
  resizeElementsUniformly,
  rotateElements,
  selectionCenter,
  translateElements,
  type OwnedResizeHandle,
} from "./editing";
import {
  isOwnedClipboardPayloadSizeAllowed,
  OWNED_CLIPBOARD_MIME,
  parseOwnedClipboardPayload,
  serializeOwnedClipboardPayload,
} from "./clipboard";

export type OwnedPointerType = "mouse" | "pen" | "touch";

export interface NormalizedWhiteboardPointer {
  readonly id: number;
  readonly type: OwnedPointerType;
  readonly point: WhiteboardPoint;
  readonly pressure: number;
  readonly buttons: number;
  readonly primary: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface PointerEventLike {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly pressure: number;
  readonly buttons: number;
  readonly isPrimary: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface OwnedInteractionSink {
  setMarquee(bounds: WhiteboardBounds | null): void;
  setPreview(element: WhiteboardElement | null): void;
  beginTextEditing(point: WhiteboardPoint): void;
}

type ActiveInteraction =
  | {
      readonly type: "pan";
      readonly pointerId: number;
      readonly button: number;
      lastPoint: WhiteboardPoint;
    }
  | {
      readonly type: "marquee";
      readonly pointerId: number;
      readonly button: number;
      readonly startPoint: WhiteboardPoint;
      readonly initialSelection: readonly string[];
      readonly toggle: boolean;
      currentBounds: WhiteboardBounds;
    }
  | {
      readonly type: "draw";
      readonly pointerId: number;
      readonly button: number;
      session: OwnedDrawingSession;
    }
  | {
      readonly type: "move";
      readonly pointerId: number;
      readonly button: number;
      readonly startPoint: WhiteboardPoint;
      readonly elements: readonly WhiteboardElement[];
    }
  | {
      readonly type: "resize";
      readonly pointerId: number;
      readonly button: number;
      readonly bounds: WhiteboardBounds;
      readonly handle: OwnedResizeHandle;
      readonly elements: readonly WhiteboardElement[];
    }
  | {
      readonly type: "rotate";
      readonly pointerId: number;
      readonly button: number;
      readonly center: WhiteboardPoint;
      readonly startAngle: number;
      readonly elements: readonly WhiteboardElement[];
    };

interface ActiveKeyboardNudge {
  readonly key: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp";
  readonly elements: readonly WhiteboardElement[];
  deltaX: number;
  deltaY: number;
}

export function normalizePointerEvent(
  event: PointerEventLike,
): NormalizedWhiteboardPointer {
  const type: OwnedPointerType =
    event.pointerType === "touch"
      ? "touch"
      : event.pointerType === "pen"
        ? "pen"
        : "mouse";
  const reportedPressure =
    Number.isFinite(event.pressure) && event.pressure >= 0
      ? Math.min(1, event.pressure)
      : 0;
  return {
    id: event.pointerId,
    type,
    point: { x: event.clientX, y: event.clientY },
    pressure:
      type === "mouse" && reportedPressure === 0 && event.buttons !== 0
        ? 0.5
        : reportedPressure,
    buttons: event.buttons,
    primary: event.isPrimary,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

export class OwnedWhiteboardInput {
  private activeInteraction: ActiveInteraction | null = null;
  private readonly unsubscribeDestroy: () => void;
  private wheelCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private activeKeyboardNudge: ActiveKeyboardNudge | null = null;
  private spacePressed = false;
  private pasteCount = 0;
  private destroyed = false;

  public constructor(
    private readonly target: HTMLElement,
    private readonly store: OwnedWhiteboardStore,
    private readonly interactionSink: OwnedInteractionSink,
    private capabilities: OwnedDrawingCapabilities = DEFAULT_OWNED_DRAWING_CAPABILITIES,
    private readonly createId: () => string = createOwnedElementId,
    private editingEnabled = true,
  ) {
    target.addEventListener("pointerdown", this.handlePointerDown);
    target.addEventListener("pointermove", this.handlePointerMove);
    target.addEventListener("pointerup", this.handlePointerUp);
    target.addEventListener("pointercancel", this.handlePointerCancel);
    target.addEventListener(
      "lostpointercapture",
      this.handleLostPointerCapture,
    );
    target.addEventListener("wheel", this.handleWheel, { passive: false });
    target.addEventListener("keydown", this.handleKeyDown);
    target.addEventListener("keyup", this.handleKeyUp);
    target.addEventListener("copy", this.handleCopy);
    target.addEventListener("cut", this.handleCut);
    target.addEventListener("paste", this.handlePaste);
    target.addEventListener("blur", this.handleBlur);
    this.unsubscribeDestroy = store.subscribeDestroy(() => this.destroy());
  }

  public setCapabilities(capabilities: OwnedDrawingCapabilities): void {
    this.capabilities = capabilities;
  }

  public setEditingEnabled(enabled: boolean): void {
    this.editingEnabled = enabled;
    if (!enabled) this.commitKeyboardNudge();
    if (
      !enabled &&
      (this.activeInteraction?.type === "move" ||
        this.activeInteraction?.type === "resize" ||
        this.activeInteraction?.type === "rotate")
    ) {
      this.store.cancelElementGesture();
      this.releaseActivePointer();
      this.activeInteraction = null;
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.commitKeyboardNudge();
    this.destroyed = true;
    this.unsubscribeDestroy();
    this.target.removeEventListener("pointerdown", this.handlePointerDown);
    this.target.removeEventListener("pointermove", this.handlePointerMove);
    this.target.removeEventListener("pointerup", this.handlePointerUp);
    this.target.removeEventListener("pointercancel", this.handlePointerCancel);
    this.target.removeEventListener(
      "lostpointercapture",
      this.handleLostPointerCapture,
    );
    this.target.removeEventListener("wheel", this.handleWheel);
    this.target.removeEventListener("keydown", this.handleKeyDown);
    this.target.removeEventListener("keyup", this.handleKeyUp);
    this.target.removeEventListener("copy", this.handleCopy);
    this.target.removeEventListener("cut", this.handleCut);
    this.target.removeEventListener("paste", this.handlePaste);
    this.target.removeEventListener("blur", this.handleBlur);
    if (this.wheelCommitTimer !== null) {
      clearTimeout(this.wheelCommitTimer);
      this.wheelCommitTimer = null;
    }
    this.releaseActivePointer();
    this.activeInteraction = null;
    this.interactionSink.setMarquee(null);
    this.interactionSink.setPreview(null);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.destroyed || !event.isPrimary || isEditableTarget(event.target)) {
      return;
    }
    this.commitKeyboardNudge();
    const pointer = normalizePointerEvent(event);
    const shouldPan =
      event.button === 1 ||
      this.spacePressed ||
      this.store.getActiveTool().type === "hand";
    if (!shouldPan && event.button !== 0) return;

    event.preventDefault();
    this.target.focus({ preventScroll: true });
    this.refreshViewportOffset();
    if (shouldPan) {
      this.interactionSink.setMarquee(null);
      this.interactionSink.setPreview(null);
      this.target.setPointerCapture?.(pointer.id);
      this.activeInteraction = {
        type: "pan",
        pointerId: pointer.id,
        button: event.button,
        lastPoint: pointer.point,
      };
      return;
    }

    const viewport = this.store.getViewport();
    const documentPoint = screenToDocument(pointer.point, viewport);
    const activeTool = this.store.getActiveTool().type;
    if (isOwnedCreatableTool(activeTool)) {
      if (!this.capabilities[activeTool]) return;
      if (activeTool === "text") {
        this.interactionSink.beginTextEditing(documentPoint);
        return;
      }
      const session = beginOwnedDrawing(activeTool, documentPoint);
      this.target.setPointerCapture?.(pointer.id);
      this.activeInteraction = {
        type: "draw",
        pointerId: pointer.id,
        button: event.button,
        session,
      };
      this.interactionSink.setPreview(
        createOwnedDrawingElement(
          session,
          this.store.getEditorState().elementStyle,
          "owned-preview",
          { preview: true },
        ),
      );
      return;
    }
    const selectedElements = this.store.getSelectedElements();
    const selectedBounds = getSelectionBounds(selectedElements);
    const transformHandle =
      this.editingEnabled && selectedBounds
        ? getTransformHandleAt(documentPoint, selectedBounds, viewport.zoom)
        : null;
    if (selectedBounds && transformHandle) {
      this.target.setPointerCapture?.(pointer.id);
      if (transformHandle === "rotate") {
        const center = selectionCenter(selectedBounds);
        this.store.beginElementGesture("rotate");
        this.activeInteraction = {
          type: "rotate",
          pointerId: pointer.id,
          button: event.button,
          center,
          startAngle: Math.atan2(
            documentPoint.y - center.y,
            documentPoint.x - center.x,
          ),
          elements: selectedElements,
        };
      } else {
        this.store.beginElementGesture("resize");
        this.activeInteraction = {
          type: "resize",
          pointerId: pointer.id,
          button: event.button,
          bounds: selectedBounds,
          handle: transformHandle,
          elements: selectedElements,
        };
      }
      return;
    }
    const hit = hitTestElements(
      this.store.getDocument().elements,
      documentPoint,
      viewport.zoom,
    );
    if (hit) {
      const toggle =
        this.editingEnabled &&
        (pointer.shiftKey || pointer.ctrlKey || pointer.metaKey);
      const selection = this.store.getEditorState().selectedElementIds;
      if (toggle) {
        this.store.setSelection(
          selection.includes(hit.id)
            ? selection.filter((id) => id !== hit.id)
            : [...selection, hit.id],
        );
        this.activeInteraction = null;
        return;
      }
      if (!selection.includes(hit.id)) this.store.setSelection([hit.id]);
      if (!this.editingEnabled) {
        this.activeInteraction = null;
        return;
      }
      const elements = this.store.getSelectedElements();
      this.store.beginElementGesture("move");
      this.target.setPointerCapture?.(pointer.id);
      this.activeInteraction = {
        type: "move",
        pointerId: pointer.id,
        button: event.button,
        startPoint: documentPoint,
        elements,
      };
      return;
    }

    const bounds = normalizeBounds(documentPoint, documentPoint);
    const toggle =
      this.editingEnabled &&
      (pointer.shiftKey || pointer.ctrlKey || pointer.metaKey);
    const initialSelection = this.store.getEditorState().selectedElementIds;
    if (!toggle) this.store.setSelection([]);
    this.target.setPointerCapture?.(pointer.id);
    this.activeInteraction = {
      type: "marquee",
      pointerId: pointer.id,
      button: event.button,
      startPoint: documentPoint,
      initialSelection,
      toggle,
      currentBounds: bounds,
    };
    this.interactionSink.setMarquee(bounds);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const interaction = this.activeInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    const pointer = normalizePointerEvent(event);
    event.preventDefault();
    if (interaction.type === "pan") {
      this.store.panBy(
        pointer.point.x - interaction.lastPoint.x,
        pointer.point.y - interaction.lastPoint.y,
        true,
      );
      interaction.lastPoint = pointer.point;
      return;
    }
    if (interaction.type === "draw") {
      this.refreshViewportOffset();
      interaction.session = updateOwnedDrawing(
        interaction.session,
        screenToDocument(pointer.point, this.store.getViewport()),
      );
      this.interactionSink.setPreview(
        createOwnedDrawingElement(
          interaction.session,
          this.store.getEditorState().elementStyle,
          "owned-preview",
          { preview: true },
        ),
      );
      return;
    }
    this.refreshViewportOffset();
    const documentPoint = screenToDocument(
      pointer.point,
      this.store.getViewport(),
    );
    if (interaction.type === "move") {
      this.store.updateElementGesture(
        translateElements(interaction.elements, {
          x: documentPoint.x - interaction.startPoint.x,
          y: documentPoint.y - interaction.startPoint.y,
        }),
      );
      return;
    }
    if (interaction.type === "resize") {
      const containsRotation = interaction.elements.some(
        (element) =>
          typeof element.angle === "number" &&
          Number.isFinite(element.angle) &&
          Math.abs(element.angle) > Number.EPSILON,
      );
      const bounds = getResizedBounds(
        interaction.bounds,
        interaction.handle,
        documentPoint,
        pointer.shiftKey || containsRotation,
      );
      this.store.updateElementGesture(
        containsRotation
          ? resizeElementsUniformly(
              interaction.elements,
              interaction.bounds,
              bounds,
              interaction.handle,
            )
          : resizeElements(interaction.elements, interaction.bounds, bounds),
      );
      return;
    }
    if (interaction.type === "rotate") {
      const angle =
        Math.atan2(
          documentPoint.y - interaction.center.y,
          documentPoint.x - interaction.center.x,
        ) - interaction.startAngle;
      this.store.updateElementGesture(
        rotateElements(interaction.elements, interaction.center, angle),
      );
      return;
    }

    interaction.currentBounds = normalizeBounds(
      interaction.startPoint,
      screenToDocument(pointer.point, this.store.getViewport()),
    );
    this.interactionSink.setMarquee(interaction.currentBounds);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const interaction = this.activeInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    if (interaction.button !== event.button) return;
    event.preventDefault();
    if (interaction.type === "pan") {
      this.store.commitTransientViewport();
    } else if (interaction.type === "draw") {
      this.refreshViewportOffset();
      const session = updateOwnedDrawing(
        interaction.session,
        screenToDocument(
          normalizePointerEvent(event).point,
          this.store.getViewport(),
        ),
      );
      const element = createOwnedDrawingElement(
        session,
        this.store.getEditorState().elementStyle,
        this.createId(),
      );
      this.interactionSink.setPreview(null);
      if (element) this.store.appendElement(element);
    } else if (
      interaction.type === "move" ||
      interaction.type === "resize" ||
      interaction.type === "rotate"
    ) {
      this.store.commitElementGesture();
    } else {
      const viewport = this.store.getViewport();
      const width =
        (interaction.currentBounds.maxX - interaction.currentBounds.minX) *
        viewport.zoom;
      const height =
        (interaction.currentBounds.maxY - interaction.currentBounds.minY) *
        viewport.zoom;
      if (Math.hypot(width, height) >= 3) {
        const candidates = elementsInBounds(
          this.store.getDocument().elements,
          interaction.currentBounds,
        ).map((element) => element.id);
        if (interaction.toggle) {
          const next = new Set(interaction.initialSelection);
          for (const id of candidates) {
            if (next.has(id)) next.delete(id);
            else next.add(id);
          }
          this.store.setSelection([...next]);
        } else {
          this.store.setSelection(candidates);
        }
      }
      this.interactionSink.setMarquee(null);
    }
    this.releaseActivePointer();
    this.activeInteraction = null;
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.activeInteraction?.pointerId !== event.pointerId) return;
    if (this.activeInteraction.type === "pan") {
      this.store.commitTransientViewport();
    } else if (
      this.activeInteraction.type === "move" ||
      this.activeInteraction.type === "resize" ||
      this.activeInteraction.type === "rotate"
    ) {
      this.store.cancelElementGesture();
    }
    this.interactionSink.setMarquee(null);
    this.interactionSink.setPreview(null);
    this.releaseActivePointer();
    this.activeInteraction = null;
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (this.activeInteraction?.pointerId !== event.pointerId) return;
    if (this.activeInteraction.type === "pan") {
      this.store.commitTransientViewport();
    } else if (
      this.activeInteraction.type === "move" ||
      this.activeInteraction.type === "resize" ||
      this.activeInteraction.type === "rotate"
    ) {
      this.store.commitElementGesture();
    }
    this.interactionSink.setMarquee(null);
    this.interactionSink.setPreview(null);
    this.activeInteraction = null;
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.refreshViewportOffset();
    const multiplier = wheelDeltaMultiplier(
      event.deltaMode,
      this.store.getViewport().height,
    );
    const deltaX = event.deltaX * multiplier;
    const deltaY = event.deltaY * multiplier;
    if (event.ctrlKey || event.metaKey) {
      const viewport = this.store.getViewport();
      this.store.zoomAt(
        { x: event.clientX, y: event.clientY },
        viewport.zoom * Math.exp(-deltaY * 0.002),
        true,
      );
    } else {
      this.store.panBy(-deltaX, -deltaY, true);
    }
    this.queueWheelCommit();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey) this.commitKeyboardNudge();
    if (commandKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (!this.editingEnabled) return;
      if (key === "a") this.store.selectAll();
      else if (key === "d") {
        this.store.duplicateSelection(this.createId);
        this.pasteCount = 0;
      } else if (key === "z" && event.shiftKey) this.store.redo();
      else if (key === "z") this.store.undo();
      else if (key === "y") this.store.redo();
      else if (key === "c" || key === "x" || key === "v") return;
      else return;
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const isArrowKey =
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown";
    if (!isArrowKey) this.commitKeyboardNudge();
    this.refreshViewportOffset();
    if (event.code === "Space") {
      this.spacePressed = true;
      event.preventDefault();
      return;
    }
    const viewport = this.store.getViewport();
    const panStep = 40;
    if (isArrowKey) {
      if (
        this.activeInteraction?.type === "move" ||
        this.activeInteraction?.type === "resize" ||
        this.activeInteraction?.type === "rotate"
      ) {
        event.preventDefault();
        return;
      }
      const selected = this.store.getSelectedElements();
      if (this.editingEnabled && selected.length > 0) {
        const step = event.shiftKey ? 10 : 1;
        if (this.activeKeyboardNudge?.key !== event.key) {
          this.commitKeyboardNudge();
        }
        if (!this.activeKeyboardNudge) {
          this.store.beginElementGesture("move");
          this.activeKeyboardNudge = {
            key: event.key,
            elements: selected,
            deltaX: 0,
            deltaY: 0,
          };
        }
        const nudge = this.activeKeyboardNudge;
        nudge.deltaX +=
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0;
        nudge.deltaY +=
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0;
        this.store.updateElementGesture(
          translateElements(nudge.elements, {
            x: nudge.deltaX,
            y: nudge.deltaY,
          }),
        );
      } else if (event.key === "ArrowLeft") this.store.panBy(panStep, 0);
      else if (event.key === "ArrowRight") this.store.panBy(-panStep, 0);
      else if (event.key === "ArrowUp") this.store.panBy(0, panStep);
      else this.store.panBy(0, -panStep);
    } else if (event.key === "+" || event.key === "=") {
      this.store.zoomAt(viewportCenter(viewport), viewport.zoom * 1.1);
    } else if (event.key === "-") {
      this.store.zoomAt(viewportCenter(viewport), viewport.zoom / 1.1);
    } else if (event.key === "0") {
      this.store.updateViewport({ zoom: 1 });
    } else if (event.key === "Home") {
      this.store.fitToContent();
    } else if (event.key === "Escape") {
      if (this.activeInteraction?.type === "pan") {
        this.store.commitTransientViewport();
      }
      if (
        this.activeInteraction?.type === "move" ||
        this.activeInteraction?.type === "resize" ||
        this.activeInteraction?.type === "rotate"
      ) {
        this.store.cancelElementGesture();
      }
      this.releaseActivePointer();
      this.store.setSelection([]);
      this.interactionSink.setMarquee(null);
      this.interactionSink.setPreview(null);
      this.activeInteraction = null;
    } else if (event.key === "Backspace" || event.key === "Delete") {
      if (!this.editingEnabled) return;
      this.store.deleteSelection();
      this.pasteCount = 0;
    } else {
      return;
    }
    event.preventDefault();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.spacePressed = false;
    if (event.key === this.activeKeyboardNudge?.key) {
      this.commitKeyboardNudge();
    }
  };

  private readonly handleCopy = (event: ClipboardEvent): void => {
    if (!this.editingEnabled || isEditableTarget(event.target)) return;
    const payload = this.store.createClipboardPayload();
    if (!payload || !event.clipboardData) return;
    const serialized = serializeOwnedClipboardPayload(payload);
    if (!isOwnedClipboardPayloadSizeAllowed(serialized)) return;
    event.clipboardData.setData(OWNED_CLIPBOARD_MIME, serialized);
    event.clipboardData.setData("text/plain", serialized);
    event.preventDefault();
    this.pasteCount = 0;
  };

  private readonly handleCut = (event: ClipboardEvent): void => {
    if (!this.editingEnabled || isEditableTarget(event.target)) return;
    const payload = this.store.createClipboardPayload();
    if (!payload || !event.clipboardData) return;
    const serialized = serializeOwnedClipboardPayload(payload);
    if (!isOwnedClipboardPayloadSizeAllowed(serialized)) return;
    event.clipboardData.setData(OWNED_CLIPBOARD_MIME, serialized);
    event.clipboardData.setData("text/plain", serialized);
    event.preventDefault();
    this.store.deleteSelection("cut");
    this.pasteCount = 0;
  };

  private readonly handlePaste = (event: ClipboardEvent): void => {
    if (
      !this.editingEnabled ||
      !event.clipboardData ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    const custom = event.clipboardData.getData(OWNED_CLIPBOARD_MIME);
    const plain = event.clipboardData.getData("text/plain");
    const payload =
      parseOwnedClipboardPayload(custom) ?? parseOwnedClipboardPayload(plain);
    if (!payload) return;
    event.preventDefault();
    this.pasteCount += 1;
    this.store.pasteClipboardPayload(
      payload,
      this.createId,
      this.pasteCount * 20,
    );
  };

  private readonly handleBlur = (): void => {
    this.spacePressed = false;
    this.commitKeyboardNudge();
    if (this.activeInteraction?.type === "pan") {
      this.store.commitTransientViewport();
    } else if (
      this.activeInteraction?.type === "move" ||
      this.activeInteraction?.type === "resize" ||
      this.activeInteraction?.type === "rotate"
    ) {
      this.store.commitElementGesture();
    }
    this.releaseActivePointer();
    this.activeInteraction = null;
    this.interactionSink.setMarquee(null);
    this.interactionSink.setPreview(null);
  };

  private refreshViewportOffset(): void {
    const bounds = this.target.getBoundingClientRect();
    this.store.syncViewportOffset(bounds.left, bounds.top);
  }

  private commitKeyboardNudge(): void {
    if (!this.activeKeyboardNudge) return;
    this.activeKeyboardNudge = null;
    if (!this.store.isDestroyed()) this.store.commitElementGesture();
  }

  private queueWheelCommit(): void {
    if (this.wheelCommitTimer !== null) clearTimeout(this.wheelCommitTimer);
    this.wheelCommitTimer = setTimeout(() => {
      this.wheelCommitTimer = null;
      if (!this.destroyed && !this.store.isDestroyed()) {
        this.store.commitTransientViewport();
      }
    }, 120);
  }

  private releaseActivePointer(): void {
    const pointerId = this.activeInteraction?.pointerId;
    if (pointerId !== undefined && this.target.hasPointerCapture?.(pointerId)) {
      this.target.releasePointerCapture?.(pointerId);
    }
  }
}

function viewportCenter(viewport: {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}): WhiteboardPoint {
  return {
    x: viewport.offsetX + viewport.width / 2,
    y: viewport.offsetY + viewport.height / 2,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function wheelDeltaMultiplier(
  deltaMode: number,
  viewportHeight: number,
): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return 16;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE)
    return Math.max(1, viewportHeight);
  return 1;
}
