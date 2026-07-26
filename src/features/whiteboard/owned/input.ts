import {
  elementsInBounds,
  hitTestElements,
  normalizeBounds,
  screenToDocument,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";
import type { OwnedWhiteboardStore } from "./store";

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
}

type ActiveInteraction =
  | {
      readonly type: "pan";
      readonly pointerId: number;
      lastPoint: WhiteboardPoint;
    }
  | {
      readonly type: "marquee";
      readonly pointerId: number;
      readonly startPoint: WhiteboardPoint;
      currentBounds: WhiteboardBounds;
    };

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
  private spacePressed = false;
  private destroyed = false;

  public constructor(
    private readonly target: HTMLElement,
    private readonly store: OwnedWhiteboardStore,
    private readonly interactionSink: OwnedInteractionSink,
  ) {
    target.addEventListener("pointerdown", this.handlePointerDown);
    target.addEventListener("pointermove", this.handlePointerMove);
    target.addEventListener("pointerup", this.handlePointerUp);
    target.addEventListener("pointercancel", this.handlePointerCancel);
    target.addEventListener("wheel", this.handleWheel, { passive: false });
    target.addEventListener("keydown", this.handleKeyDown);
    target.addEventListener("keyup", this.handleKeyUp);
    target.addEventListener("blur", this.handleBlur);
    this.unsubscribeDestroy = store.subscribeDestroy(() => this.destroy());
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeDestroy();
    this.target.removeEventListener("pointerdown", this.handlePointerDown);
    this.target.removeEventListener("pointermove", this.handlePointerMove);
    this.target.removeEventListener("pointerup", this.handlePointerUp);
    this.target.removeEventListener("pointercancel", this.handlePointerCancel);
    this.target.removeEventListener("wheel", this.handleWheel);
    this.target.removeEventListener("keydown", this.handleKeyDown);
    this.target.removeEventListener("keyup", this.handleKeyUp);
    this.target.removeEventListener("blur", this.handleBlur);
    if (this.wheelCommitTimer !== null) {
      clearTimeout(this.wheelCommitTimer);
      this.wheelCommitTimer = null;
    }
    this.releaseActivePointer();
    this.activeInteraction = null;
    this.interactionSink.setMarquee(null);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.destroyed || !event.isPrimary) return;
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
      this.target.setPointerCapture?.(pointer.id);
      this.activeInteraction = {
        type: "pan",
        pointerId: pointer.id,
        lastPoint: pointer.point,
      };
      return;
    }

    const viewport = this.store.getViewport();
    const documentPoint = screenToDocument(pointer.point, viewport);
    const hit = hitTestElements(
      this.store.getDocument().elements,
      documentPoint,
      viewport.zoom,
    );
    if (hit) {
      this.store.setSelection([hit.id]);
      this.activeInteraction = null;
      return;
    }

    const bounds = normalizeBounds(documentPoint, documentPoint);
    this.store.setSelection([]);
    this.target.setPointerCapture?.(pointer.id);
    this.activeInteraction = {
      type: "marquee",
      pointerId: pointer.id,
      startPoint: documentPoint,
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

    this.refreshViewportOffset();
    interaction.currentBounds = normalizeBounds(
      interaction.startPoint,
      screenToDocument(pointer.point, this.store.getViewport()),
    );
    this.interactionSink.setMarquee(interaction.currentBounds);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const interaction = this.activeInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (interaction.type === "pan") {
      this.store.commitTransientViewport();
    } else {
      const viewport = this.store.getViewport();
      const width =
        (interaction.currentBounds.maxX - interaction.currentBounds.minX) *
        viewport.zoom;
      const height =
        (interaction.currentBounds.maxY - interaction.currentBounds.minY) *
        viewport.zoom;
      if (Math.hypot(width, height) >= 3) {
        this.store.setSelection(
          elementsInBounds(
            this.store.getDocument().elements,
            interaction.currentBounds,
          ).map((element) => element.id),
        );
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
    }
    this.interactionSink.setMarquee(null);
    this.releaseActivePointer();
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
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    this.refreshViewportOffset();
    if (event.code === "Space") {
      this.spacePressed = true;
      event.preventDefault();
      return;
    }
    const viewport = this.store.getViewport();
    const panStep = 40;
    if (event.key === "ArrowLeft") this.store.panBy(panStep, 0);
    else if (event.key === "ArrowRight") this.store.panBy(-panStep, 0);
    else if (event.key === "ArrowUp") this.store.panBy(0, panStep);
    else if (event.key === "ArrowDown") this.store.panBy(0, -panStep);
    else if (event.key === "+" || event.key === "=") {
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
      this.releaseActivePointer();
      this.store.setSelection([]);
      this.interactionSink.setMarquee(null);
      this.activeInteraction = null;
    } else {
      return;
    }
    event.preventDefault();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.spacePressed = false;
  };

  private readonly handleBlur = (): void => {
    this.spacePressed = false;
    if (this.activeInteraction?.type === "pan") {
      this.store.commitTransientViewport();
    }
    this.releaseActivePointer();
    this.activeInteraction = null;
    this.interactionSink.setMarquee(null);
  };

  private refreshViewportOffset(): void {
    const bounds = this.target.getBoundingClientRect();
    this.store.syncViewportOffset(bounds.left, bounds.top);
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
