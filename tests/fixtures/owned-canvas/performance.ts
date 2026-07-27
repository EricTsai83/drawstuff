import type {
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@/features/whiteboard";

export type OwnedPerformanceFixtureName = "small" | "medium" | "large";

export interface OwnedPerformanceFixture {
  readonly name: OwnedPerformanceFixtureName;
  readonly document: OwnedWhiteboardDocument;
  readonly expectedElementCount: number;
}

const FIXTURE_SIZES: Readonly<Record<OwnedPerformanceFixtureName, number>> = {
  small: 32,
  medium: 512,
  large: 4096,
};

export const OWNED_CANVAS_PERFORMANCE_FIXTURES: readonly OwnedPerformanceFixture[] =
  (
    Object.entries(FIXTURE_SIZES) as [OwnedPerformanceFixtureName, number][]
  ).map(([name, size]) => ({
    name,
    expectedElementCount: size,
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

function createFixtureElement(index: number): WhiteboardElement {
  const column = index % 64;
  const row = Math.floor(index / 64);
  return {
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
  };
}
