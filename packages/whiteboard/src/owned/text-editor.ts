import { createOwnedElementId } from "./drawing";
import { documentToScreen, type WhiteboardPoint } from "./geometry";
import type { WhiteboardElement, WhiteboardTextElementV3 } from "../contracts";
import type { OwnedWhiteboardStore } from "./store";
import { resolveOwnedThemeColor } from "./theme-color";

export class OwnedWhiteboardTextEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private point: WhiteboardPoint | null = null;
  private targetId: string | null = null;
  private angle = 0;
  private fixedWidth = false;
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

  public begin(point: WhiteboardPoint, target?: WhiteboardElement): void {
    this.commit();
    const editedText =
      target?.type === "text" && "fontFamily" in target
        ? target
        : target
          ? this.store.getBoundTextForContainer(target.id)
          : null;
    const editorPoint = editedText
      ? { x: editedText.x, y: editedText.y }
      : target
        ? { x: target.x + 8, y: target.y + 8 }
        : point;
    const fontSize = editedText?.fontSize ?? 20;
    const lineHeight = editedText?.lineHeight ?? 1.25;
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
      font: `${fontSize}px/${lineHeight} ${fontFamily(editedText)}`,
      color: resolveOwnedThemeColor(
        this.store.getEditorState().elementStyle.strokeColor,
        this.store.getEditorState().theme,
      ),
      transformOrigin: "top left",
    });
    textarea.value = editedText?.text ?? "";
    textarea.addEventListener("input", this.resizeEditor);
    textarea.addEventListener("keydown", this.handleKeyDown);
    textarea.addEventListener("blur", this.handleBlur);
    this.textarea = textarea;
    this.point = editorPoint;
    this.targetId = target?.id ?? null;
    this.angle = editedText?.angle ?? target?.angle ?? 0;
    this.fixedWidth = Boolean(target && target.type !== "text");
    if (this.fixedWidth && target) {
      textarea.style.width = `${Math.max(24, target.width - 16)}px`;
    }
    this.root.append(textarea);
    this.store.setTextEditing(true);
    this.resizeEditor();
    this.positionEditor();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, textarea.value.length);
  }

  public commit(): void {
    const textarea = this.textarea;
    const point = this.point;
    if (!textarea || !point) return;
    const text = textarea.value;
    const targetId = this.targetId;
    const dimensions = {
      width: readCssPixels(textarea.style.width),
      height: readCssPixels(textarea.style.height),
    };
    this.releaseEditor();
    this.store.commitTextEdit({
      targetId,
      point,
      text,
      width: dimensions.width,
      height: dimensions.height,
      createId: this.createId,
    });
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
    if (!this.fixedWidth) textarea.style.width = "1px";
    textarea.style.height = "1px";
    if (!this.fixedWidth) {
      textarea.style.width = `${Math.max(24, textarea.scrollWidth + 2)}px`;
    }
    textarea.style.height = `${Math.max(25, textarea.scrollHeight + 2)}px`;
  };

  private positionEditor(): void {
    const textarea = this.textarea;
    const point = this.point;
    if (!textarea || !point || this.store.isDestroyed()) return;
    const viewport = this.store.getViewport();
    const editorState = this.store.getEditorState();
    const screenPoint = documentToScreen(point, viewport);
    textarea.style.left = `${screenPoint.x - viewport.offsetX}px`;
    textarea.style.top = `${screenPoint.y - viewport.offsetY}px`;
    textarea.style.transform =
      this.angle === 0
        ? `scale(${viewport.zoom})`
        : `scale(${viewport.zoom}) rotate(${this.angle}rad)`;
    textarea.style.color = resolveOwnedThemeColor(
      editorState.elementStyle.strokeColor,
      editorState.theme,
    );
  }

  private releaseEditor(): void {
    const textarea = this.textarea;
    if (!textarea) return;
    this.textarea = null;
    this.point = null;
    this.targetId = null;
    this.angle = 0;
    this.fixedWidth = false;
    if (!this.store.isDestroyed()) this.store.setTextEditing(false);
    textarea.removeEventListener("input", this.resizeEditor);
    textarea.removeEventListener("keydown", this.handleKeyDown);
    textarea.removeEventListener("blur", this.handleBlur);
    textarea.remove();
  }
}

function fontFamily(text: WhiteboardTextElementV3 | null): string {
  if (text?.fontFamily === "nunito") return "Nunito, sans-serif";
  if (text?.fontFamily === "system") return "system-ui, sans-serif";
  return "Excalifont, sans-serif";
}

function readCssPixels(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
