import type { WhiteboardTextElementV3 } from "../contracts";

export const OWNED_BOUND_TEXT_PADDING = 8;

export interface OwnedTextLayoutLine {
  readonly text: string;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface OwnedTextLayout {
  readonly font: string;
  readonly fontFamily: string;
  readonly lineHeightPx: number;
  readonly width: number;
  readonly height: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly lines: readonly OwnedTextLayoutLine[];
}

export interface OwnedTextMeasureResult {
  readonly width: number;
}

export function getWhiteboardFontFamily(
  family: WhiteboardTextElementV3["fontFamily"],
): string {
  if (family === "nunito") return '"Nunito", sans-serif';
  if (family === "system") return "system-ui, sans-serif";
  return '"Excalifont", sans-serif';
}

export function getWhiteboardFontDescriptor(options: {
  readonly fontFamily: WhiteboardTextElementV3["fontFamily"];
  readonly fontSize: number;
}): string {
  return `${Math.max(1, options.fontSize)}px ${getWhiteboardFontFamily(options.fontFamily)}`;
}

export function layoutWhiteboardText(options: {
  readonly text: string;
  readonly fontFamily: WhiteboardTextElementV3["fontFamily"];
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly textAlign: WhiteboardTextElementV3["textAlign"];
  readonly verticalAlign: WhiteboardTextElementV3["verticalAlign"];
  readonly width: number;
  readonly height: number;
  readonly autoResize: boolean;
  readonly measureText: (text: string) => OwnedTextMeasureResult;
}): OwnedTextLayout {
  const fontSize = Math.max(1, options.fontSize);
  const lineHeightPx = fontSize * Math.max(0.5, options.lineHeight);
  const fixedWidth = !options.autoResize;
  const maxWidth = Math.max(1, options.width);
  const paragraphs = options.text.split("\n");
  const lines = paragraphs.flatMap((paragraph) =>
    fixedWidth
      ? wrapParagraph(paragraph, maxWidth, options.measureText)
      : [measureLine(paragraph, options.measureText)],
  );
  if (lines.length === 0) lines.push(measureLine("", options.measureText));
  const contentWidth = Math.max(0, ...lines.map((line) => line.width));
  const contentHeight = Math.max(lineHeightPx, lines.length * lineHeightPx);
  const width = fixedWidth ? maxWidth : Math.max(1, contentWidth);
  const height = options.autoResize
    ? contentHeight
    : Math.max(contentHeight, options.height);
  const verticalOffset =
    options.verticalAlign === "middle"
      ? (height - contentHeight) / 2
      : options.verticalAlign === "bottom"
        ? height - contentHeight
        : 0;
  return {
    font: getWhiteboardFontDescriptor(options),
    fontFamily: getWhiteboardFontFamily(options.fontFamily),
    lineHeightPx,
    width,
    height,
    contentWidth,
    contentHeight,
    lines: lines.map((line, index) => ({
      ...line,
      x:
        options.textAlign === "center"
          ? (width - line.width) / 2
          : options.textAlign === "right"
            ? width - line.width
            : 0,
      y: verticalOffset + index * lineHeightPx,
    })),
  };
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  measureText: (text: string) => OwnedTextMeasureResult,
): OwnedTextMeasureResultWithText[] {
  if (paragraph.length === 0) return [measureLine("", measureText)];
  const lines: OwnedTextMeasureResultWithText[] = [];
  let current = "";
  for (const character of paragraph) {
    const candidate = current + character;
    if (measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    const breakAt = Math.max(
      current.lastIndexOf(" "),
      current.lastIndexOf("\t"),
    );
    if (breakAt >= 0) {
      lines.push(measureLine(current.slice(0, breakAt).trimEnd(), measureText));
      current = `${current.slice(breakAt + 1)}${character}`.trimStart();
    } else if (current.length > 0) {
      lines.push(measureLine(current, measureText));
      current = character.trimStart();
    } else {
      current = character;
    }
  }
  lines.push(measureLine(current.trimEnd(), measureText));
  return lines;
}

interface OwnedTextMeasureResultWithText extends OwnedTextMeasureResult {
  readonly text: string;
}

function measureLine(
  text: string,
  measureText: (text: string) => OwnedTextMeasureResult,
): OwnedTextMeasureResultWithText {
  return { text, width: Math.max(0, measureText(text).width) };
}
