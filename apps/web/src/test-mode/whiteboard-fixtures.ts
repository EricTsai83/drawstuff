import type {
  OwnedWhiteboardDocument,
  WhiteboardBoxElementV3,
  WhiteboardElement,
  WhiteboardTextElementV3,
} from "@drawstuff/whiteboard";

export type WhiteboardTestFixtureName =
  | "mixed-1k"
  | "mixed-10k"
  | "mixed-50k"
  | "visible-1k-of-10k"
  | "text-500"
  | "freedraw-2k";

export function createWhiteboardTestFixture(
  name: WhiteboardTestFixtureName,
  theme: "light" | "dark",
): OwnedWhiteboardDocument {
  const elements =
    name === "freedraw-2k"
      ? [freedraw()]
      : name === "text-500"
        ? Array.from({ length: 500 }, (_, index) => text(index))
        : mixed(fixtureSize(name), name === "visible-1k-of-10k");
  return {
    elements,
    assets: {},
    state: {
      name,
      theme,
      viewBackgroundColor: theme === "dark" ? "#121212" : "#ffffff",
      gridSize: null,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    },
  };
}

function fixtureSize(name: WhiteboardTestFixtureName): number {
  if (name === "mixed-50k") return 50_000;
  if (name === "mixed-10k" || name === "visible-1k-of-10k") return 10_000;
  return 1_000;
}

function mixed(count: number, sparse: boolean): readonly WhiteboardElement[] {
  return Array.from({ length: count }, (_, index) => {
    const column = index % 100;
    const row = Math.floor(index / 100);
    const far = sparse && index >= 1_000 ? 100_000 : 0;
    return rectangle(index, far + column * 140, row * 90);
  });
}

function rectangle(
  index: number,
  x: number,
  y: number,
): WhiteboardBoxElementV3 {
  const id = `fixture-${index.toString().padStart(5, "0")}`;
  return {
    ...base(id, index, x, y),
    type:
      index % 3 === 0 ? "diamond" : index % 3 === 1 ? "ellipse" : "rectangle",
  };
}

function text(index: number): WhiteboardTextElementV3 {
  const id = `text-${index.toString().padStart(4, "0")}`;
  return {
    ...base(id, index, (index % 25) * 180, Math.floor(index / 25) * 80),
    type: "text",
    text: `Deterministic text ${index}`,
    originalText: `Deterministic text ${index}`,
    fontFamily: index % 2 === 0 ? "excalifont" : "nunito",
    fontSize: 20,
    lineHeight: 1.25,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
  };
}

function freedraw(): WhiteboardElement {
  return {
    ...base("freedraw-2000", 0, 0, 0),
    type: "freedraw",
    width: 1_999,
    height: 100,
    points: Array.from(
      { length: 2_000 },
      (_, index) => [index, 50 + Math.sin(index / 20) * 50] as const,
    ),
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: [1_999, 25],
  };
}

function base(id: string, index: number, x: number, y: number) {
  return {
    id,
    index: `a${index.toString(36).padStart(8, "0")}`,
    isDeleted: false,
    x,
    y,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 1,
    strokeStyle: "solid" as const,
    opacity: 100,
    roughness: 1,
    roundness: "round" as const,
    seed: index + 1,
    version: 1,
    versionNonce: index + 10_001,
    updatedAt: 1,
    groupIds: [] as readonly string[],
    frameId: null,
    locked: false,
  };
}
