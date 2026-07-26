import { createOwnedElementId, createOwnedTextElement } from "./drawing";
import { documentToScreen, type WhiteboardPoint } from "./geometry";
import type { OwnedWhiteboardStore } from "./store";

export class OwnedWhiteboardTextEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private point: WhiteboardPoint | null = null;
  private cancelling = false;
  private readonly unsubscribeEditor: () => void;
  private readonly unsubscribeRender: () => void;
  private readonly unsubscribeDestroy: () => void;

  public constructor(
    private readonly root: HTMLElement,
    private readonly store: OwnedWhiteboardStore,
    private readonly createId: () => string = createOwnedElementId,
  ) {
    this.unsubscribeEditor = store.subscribeEditorState(() =>
      this.positionEditor(),
    );
    this.unsubscribeRender = store.subscribeRenderState(() =>
      this.positionEditor(),
    );
    this.unsubscribeDestroy = store.subscribeDestroy(() => this.destroy());
  }

  public begin(point: WhiteboardPoint): void {
    this.commit();
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "Edit text");
    textarea.setAttribute("autocapitalize", "sentences");
    textarea.rows = 1;
    textarea.spellcheck = true;
    Object.assign(textarea.style, {
      position: "absolute",
      zIndex: "10",
      minWidth: "2ch",
      minHeight: "1.25em",
      padding: "0",
      border: "0",
      outline: "1px solid #4c6ef5",
      overflow: "hidden",
      resize: "none",
      background: "transparent",
      font: "20px/1.25 sans-serif",
      color: this.store.getEditorState().elementStyle.strokeColor,
      transformOrigin: "top left",
    });
    textarea.addEventListener("input", this.resizeEditor);
    textarea.addEventListener("keydown", this.handleKeyDown);
    textarea.addEventListener("blur", this.handleBlur);
    this.textarea = textarea;
    this.point = point;
    this.root.append(textarea);
    this.positionEditor();
    textarea.focus({ preventScroll: true });
  }

  public commit(): void {
    const textarea = this.textarea;
    const point = this.point;
    if (!textarea || !point) return;
    const text = textarea.value;
    const dimensions = {
      width: readCssPixels(textarea.style.width),
      height: readCssPixels(textarea.style.height),
    };
    this.releaseEditor();
    const element = createOwnedTextElement(
      point,
      text,
      this.store.getEditorState().elementStyle,
      this.createId(),
      dimensions,
    );
    if (element) this.store.appendElement(element);
  }

  public cancel(): void {
    if (!this.textarea) return;
    this.cancelling = true;
    this.releaseEditor();
    this.cancelling = false;
  }

  public destroy(): void {
    this.cancel();
    this.unsubscribeEditor();
    this.unsubscribeRender();
    this.unsubscribeDestroy();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      this.root.focus({ preventScroll: true });
      return;
    }
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.isComposing
    ) {
      event.preventDefault();
      this.commit();
      this.root.focus({ preventScroll: true });
    }
  };

  private readonly handleBlur = (): void => {
    if (!this.cancelling) this.commit();
  };

  private readonly resizeEditor = (): void => {
    const textarea = this.textarea;
    if (!textarea) return;
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.width = `${Math.max(24, textarea.scrollWidth + 2)}px`;
    textarea.style.height = `${Math.max(25, textarea.scrollHeight + 2)}px`;
  };

  private positionEditor(): void {
    const textarea = this.textarea;
    const point = this.point;
    if (!textarea || !point || this.store.isDestroyed()) return;
    const viewport = this.store.getViewport();
    const screenPoint = documentToScreen(point, viewport);
    textarea.style.left = `${screenPoint.x - viewport.offsetX}px`;
    textarea.style.top = `${screenPoint.y - viewport.offsetY}px`;
    textarea.style.transform = `scale(${viewport.zoom})`;
  }

  private releaseEditor(): void {
    const textarea = this.textarea;
    if (!textarea) return;
    this.textarea = null;
    this.point = null;
    textarea.removeEventListener("input", this.resizeEditor);
    textarea.removeEventListener("keydown", this.handleKeyDown);
    textarea.removeEventListener("blur", this.handleBlur);
    textarea.remove();
  }
}

function readCssPixels(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
