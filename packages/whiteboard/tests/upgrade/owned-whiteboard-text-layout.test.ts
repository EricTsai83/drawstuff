import { describe, expect, it } from "vitest";
import {
  getWhiteboardFontDescriptor,
  layoutWhiteboardText,
} from "@drawstuff/whiteboard";

const measureText = (text: string): { readonly width: number } => ({
  width: text.length * 10,
});

describe("owned whiteboard text layout", () => {
  it("wraps fixed-width text and aligns lines consistently", () => {
    const layout = layoutWhiteboardText({
      text: "hello world",
      fontFamily: "excalifont",
      fontSize: 20,
      lineHeight: 1.25,
      textAlign: "center",
      verticalAlign: "middle",
      width: 60,
      height: 100,
      autoResize: false,
      measureText,
    });

    expect(layout.lines).toEqual([
      { text: "hello", width: 50, x: 5, y: 25 },
      { text: "world", width: 50, x: 5, y: 50 },
    ]);
    expect(layout.contentHeight).toBe(50);
    expect(layout.width).toBe(60);
    expect(layout.height).toBe(100);
  });

  it("expands auto-resize text and supports right/bottom alignment", () => {
    const layout = layoutWhiteboardText({
      text: "a\nlong",
      fontFamily: "nunito",
      fontSize: 10,
      lineHeight: 2,
      textAlign: "right",
      verticalAlign: "bottom",
      width: 10,
      height: 100,
      autoResize: true,
      measureText,
    });

    expect(layout.width).toBe(40);
    expect(layout.height).toBe(40);
    expect(layout.lines).toEqual([
      { text: "a", width: 10, x: 30, y: 0 },
      { text: "long", width: 40, x: 0, y: 20 },
    ]);
    expect(
      getWhiteboardFontDescriptor({ fontFamily: "nunito", fontSize: 10 }),
    ).toBe('10px "Nunito", sans-serif');
  });

  it("breaks overlong unspaced text without losing characters", () => {
    const layout = layoutWhiteboardText({
      text: "abcdefg",
      fontFamily: "system",
      fontSize: 10,
      lineHeight: 1,
      textAlign: "left",
      verticalAlign: "top",
      width: 30,
      height: 1,
      autoResize: false,
      measureText,
    });

    expect(layout.lines.map((line) => line.text)).toEqual(["abc", "def", "g"]);
  });
});
