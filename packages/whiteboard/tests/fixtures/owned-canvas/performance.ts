import type {
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../../helpers";

export type OwnedPerformanceFixtureName = "small" | "medium" | "large";

export interface OwnedPerformanceFixture {
  readonly name: OwnedPerformanceFixtureName;
  readonly document: OwnedWhiteboardDocument;
  readonly expectedElementCount: number;
  readonly expectedPaintedCount: number;
}

export type OwnedBenchmarkFixtureName =
  | "elements-1k"
  | "elements-10k"
  | "elements-50k"
  | "visible-1k-of-10k"
  | "rough-1k"
  | "text-500"
  | "bound-text-500"
  | "bindings-500"
  | "frames-groups-100"
  | "freedraw-2k"
  | "large-and-missing-images";

export interface OwnedBenchmarkFixture {
  readonly name: OwnedBenchmarkFixtureName;
  readonly document: OwnedWhiteboardDocument;
  readonly totalElements: number;
  readonly expectedVisibleElements: number;
}

const FIXTURE_SIZES: Readonly<Record<OwnedPerformanceFixtureName, number>> = {
  small: 32,
  medium: 512,
  large: 4096,
};

const EXPECTED_PAINTED_COUNTS: Readonly<
  Record<OwnedPerformanceFixtureName, number>
> = {
  small: 32,
  medium: 280,
  large: 1050,
};

export const OWNED_CANVAS_PERFORMANCE_FIXTURES: readonly OwnedPerformanceFixture[] =
  (
    Object.entries(FIXTURE_SIZES) as [OwnedPerformanceFixtureName, number][]
  ).map(([name, size]) => ({
    name,
    expectedElementCount: size,
    expectedPaintedCount: EXPECTED_PAINTED_COUNTS[name],
    document: Object.freeze({
      elements: Object.freeze(
        Array.from({ length: size }, (_, index) => createFixtureElement(index)),
      ),
      assets: Object.freeze({}),
      state: Object.freeze({
        name: `Owned canvas ${name} baseline`,
        theme: "light" as const,
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      }),
    }),
  }));

export function createOwnedBenchmarkFixture(
  name: OwnedBenchmarkFixtureName,
): OwnedBenchmarkFixture {
  const descriptor = benchmarkDescriptor(name);
  const elements =
    name === "freedraw-2k"
      ? [createFreedrawFixture()]
      : Array.from({ length: descriptor.total }, (_, index) =>
          createMixedFixtureElement(
            index,
            name === "visible-1k-of-10k" && index >= 1_000,
            name,
          ),
        );
  return {
    name,
    totalElements: elements.length,
    expectedVisibleElements: descriptor.visible,
    document: {
      elements,
      assets: {},
      state: {
        name: `Benchmark ${name}`,
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    },
  };
}

function benchmarkDescriptor(name: OwnedBenchmarkFixtureName): {
  readonly total: number;
  readonly visible: number;
} {
  switch (name) {
    case "elements-1k":
    case "rough-1k":
      return { total: 1_000, visible: 1_000 };
    case "elements-10k":
      return { total: 10_000, visible: 10_000 };
    case "elements-50k":
      return { total: 50_000, visible: 50_000 };
    case "visible-1k-of-10k":
      return { total: 10_000, visible: 1_000 };
    case "text-500":
      return { total: 500, visible: 500 };
    case "bound-text-500":
    case "bindings-500":
      return { total: 1_000, visible: 1_000 };
    case "frames-groups-100":
      return { total: 100, visible: 100 };
    case "large-and-missing-images":
      return { total: 20, visible: 20 };
    case "freedraw-2k":
      return { total: 1, visible: 1 };
  }
}

function createMixedFixtureElement(
  index: number,
  offscreen: boolean,
  name: OwnedBenchmarkFixtureName,
): WhiteboardElement {
  const base = createFixtureElement(index);
  const translated = offscreen
    ? { ...base, x: base.x + 100_000, y: base.y + 100_000 }
    : base;
  if (name === "bound-text-500" && index < 500) {
    return { ...translated, id: `container-${index}` };
  }
  if (name === "text-500" || name === "bound-text-500") {
    const textIndex = name === "bound-text-500" ? index - 500 : index;
    return createTestElementV3({
      ...translated,
      type: "text",
      text: `Deterministic text ${textIndex}`,
      originalText: `Deterministic text ${textIndex}`,
      fontSize: 20,
      lineHeight: 1.25,
      containerId: name === "bound-text-500" ? `container-${textIndex}` : null,
    });
  }
  if (name === "bindings-500" && index < 500) {
    return { ...translated, id: `binding-target-${index}` };
  }
  if (name === "bindings-500") {
    const bindingIndex = index - 500;
    return createTestElementV3({
      ...translated,
      type: "arrow",
      points: [
        [0, 0],
        [24, 16],
      ],
      startBinding: {
        elementId: `binding-target-${bindingIndex}`,
        focus: 0,
        gap: 4,
      },
      endBinding: null,
    });
  }
  if (name === "frames-groups-100") {
    return createTestElementV3({
      ...translated,
      type: index % 10 === 0 ? "frame" : "rectangle",
      groupIds: [`group-${Math.floor(index / 5)}`],
      frameId: index % 10 === 0 ? null : `fixture-${index - (index % 10)}`,
    });
  }
  if (name === "large-and-missing-images") {
    return createTestElementV3({
      ...translated,
      type: "image",
      fileId: `missing-${index}`,
      width: 2_000,
      height: 1_500,
    });
  }
  return translated;
}

function createFreedrawFixture(): WhiteboardElement {
  return createTestElementV3({
    ...createFixtureElement(0),
    type: "freedraw",
    width: 1_999,
    height: 40,
    points: Array.from(
      { length: 2_000 },
      (_, index) => [index, 20 + Math.sin(index / 8) * 20] as const,
    ),
    pressures: Array.from({ length: 2_000 }, (_, index) => (index % 10) / 10),
  });
}

function createFixtureElement(index: number): WhiteboardElement {
  const column = index % 64;
  const row = Math.floor(index / 64);
  return createTestElementV3({
    id: `fixture-${index}`,
    type: index % 7 === 0 ? "ellipse" : "rectangle",
    isDeleted: false,
    x: column * 36,
    y: row * 28,
    width: 24,
    height: 16,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: index % 2 === 0 ? "#dbe4ff" : "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 1,
    locked: false,
  });
}
