// @vitest-environment jsdom

/**
 * Upstream public-API reproduction and audit suite for
 * `@excalidraw/excalidraw@0.18.1`.
 *
 * Every `confirmed gap` below pins the *current* upstream behaviour, so the
 * assertion passes today and fails the moment upstream closes the gap. The
 * `public API` cases are spikes proving the capability needs no seam.
 *
 * See docs/architecture/03-public-api-gap-audit.md for the capability matrix.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as upstream from "@excalidraw/excalidraw";
import {
  CaptureUpdateAction,
  type Footer,
  MainMenu,
  newElementWith,
  Stats,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  CanvasActions,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  ExportOpts,
  SocketId,
  ToolType,
} from "@excalidraw/excalidraw/types";
import { describe, expect, it } from "vitest";

import type {
  ExcalidrawCanvasProps,
  ExcalidrawValidateEmbeddable,
} from "../src/types";

type CaptureUpdateActionType =
  (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction];

type ToolCommand = Parameters<ExcalidrawImperativeAPI["setActiveTool"]>[0];

/**
 * `updateScene` is generic over the patched appState keys, so `Parameters<...>`
 * would widen the patch to the whole `AppState`. The recorder keeps the payload
 * shape the adapter actually sends.
 */
type RecordedSceneUpdate = {
  appState?: Partial<AppState> | null;
  captureUpdate?: CaptureUpdateActionType;
  collaborators?: Map<SocketId, Collaborator>;
  elements?: readonly ExcalidrawElement[];
};

const createRecordingApi = (): {
  api: ExcalidrawImperativeAPI;
  sceneUpdates: RecordedSceneUpdate[];
  toolCommands: ToolCommand[];
} => {
  const toolCommands: ToolCommand[] = [];
  const sceneUpdates: RecordedSceneUpdate[] = [];
  const api = {
    setActiveTool: (tool: ToolCommand) => {
      toolCommands.push(tool);
    },
    updateScene: (sceneData: RecordedSceneUpdate) => {
      sceneUpdates.push(sceneData);
    },
  } as unknown as ExcalidrawImperativeAPI;

  return { api, sceneUpdates, toolCommands };
};

const upstreamExportNames = Object.keys(upstream).sort();

/** Node's own resolver, used to pin what upstream exposes at *runtime*. */
const requireFromTest = createRequire(import.meta.url);

/**
 * Compile-time tripwire for the `Exclude<keyof T, audited>` types below. The
 * type argument is constrained to `never`, so the moment upstream adds a
 * member the audited array does not list, `tsc` fails at the *call site*. The
 * runtime body is incidental — and is exactly why this has to be a constrained
 * call rather than the obvious `const unaudited: Unaudited[] = []` plus
 * `expect(unaudited).toEqual([])`, which stays green forever because nothing
 * ever populates that array.
 */
const assertNoUnauditedKeys = <TUnaudited extends never>(
  ...unaudited: TUnaudited[]
): void => {
  expect(unaudited).toEqual([]);
};

const nativeElements = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "fixtures/native-excalidraw-elements.json",
    ),
    "utf8",
  ),
) as ExcalidrawElement[];

type LinearElement = Extract<ExcalidrawElement, { type: "arrow" | "line" }>;

const findLinear = (
  elements: readonly ExcalidrawElement[],
  id: string,
): LinearElement => {
  const element = elements.find((candidate) => candidate.id === id);
  if (!element || (element.type !== "arrow" && element.type !== "line")) {
    throw new Error(`fixture must contain the linear element ${id}`);
  }

  return element;
};

type TextElement = Extract<ExcalidrawElement, { type: "text" }>;

const findBoundText = (
  elements: readonly ExcalidrawElement[],
  id: string,
): TextElement => {
  const element = elements.find((candidate) => candidate.id === id);
  if (element?.type !== "text" || element.containerId === null) {
    throw new Error(`fixture must contain the container-bound text ${id}`);
  }

  return element;
};

/**
 * The full 0.18.1 public surface. `as const satisfies` fails to compile if a
 * listed member disappears; `assertNoUnauditedKeys<Exclude<...>>()` fails to
 * compile if upstream adds one. Either way an upgrade forces a re-audit.
 */
const IMPERATIVE_API_KEYS = [
  "addFiles",
  "getAppState",
  "getFiles",
  "getName",
  "getSceneElements",
  "getSceneElementsIncludingDeleted",
  "history",
  "id",
  "onChange",
  "onPointerDown",
  "onPointerUp",
  "onScrollChange",
  "onUserFollow",
  "refresh",
  "registerAction",
  "resetCursor",
  "resetScene",
  "scrollToContent",
  "setActiveTool",
  "setCursor",
  "setToast",
  "toggleSidebar",
  "updateFrameRendering",
  "updateLibrary",
  "updateScene",
] as const satisfies readonly (keyof ExcalidrawImperativeAPI)[];

type UnauditedImperativeApiKey = Exclude<
  keyof ExcalidrawImperativeAPI,
  (typeof IMPERATIVE_API_KEYS)[number]
>;

const EDITOR_PROP_KEYS = [
  "aiEnabled",
  "autoFocus",
  "children",
  "detectScroll",
  "excalidrawAPI",
  "generateIdForFile",
  "generateLinkForSelection",
  "gridModeEnabled",
  "handleKeyboardGlobally",
  "initialData",
  "isCollaborating",
  "langCode",
  "libraryReturnUrl",
  "name",
  "objectsSnapModeEnabled",
  "onChange",
  "onDuplicate",
  "onLibraryChange",
  "onLinkOpen",
  "onPaste",
  "onPointerDown",
  "onPointerUp",
  "onPointerUpdate",
  "onScrollChange",
  "onUserFollow",
  "renderCustomStats",
  "renderEmbeddable",
  "renderTopRightUI",
  "showDeprecatedFonts",
  "theme",
  "UIOptions",
  "validateEmbeddable",
  "viewModeEnabled",
  "zenModeEnabled",
] as const satisfies readonly (keyof ExcalidrawProps)[];

type UnauditedEditorPropKey = Exclude<
  keyof ExcalidrawProps,
  (typeof EDITOR_PROP_KEYS)[number]
>;

describe("upstream 0.18.1 public API surface", () => {
  it("pins the audited imperative API and editor props", () => {
    assertNoUnauditedKeys<UnauditedImperativeApiKey>();
    assertNoUnauditedKeys<UnauditedEditorPropKey>();

    expect(IMPERATIVE_API_KEYS).toHaveLength(25);
    expect(EDITOR_PROP_KEYS).toHaveLength(34);
  });

  it("does not export the internal command, history or i18n machinery", () => {
    expect(upstreamExportNames).toEqual(
      expect.arrayContaining([
        "CaptureUpdateAction",
        "Footer",
        "MainMenu",
        "UserIdleState",
        "getSceneVersion",
        "hashElementsVersion",
        "newElementWith",
        "reconcileElements",
        "restore",
        "useDevice",
      ]),
    );

    for (const internalSymbol of [
      "ActionManager",
      "History",
      "Store",
      "actionRedo",
      "actionUndo",
      "embeddableURLValidator",
      "getSelectedElements",
      "setLanguage",
      "t",
    ]) {
      expect(upstreamExportNames).not.toContain(internalSymbol);
    }
  });
});

/**
 * The native UI integration contract: the slice of the surface above that
 * Drawstuff actually mounts into.
 *
 * Every entry is something `apps/web/src/components/excalidraw/*` passes or
 * renders today, so an upstream upgrade that drops one of them fails `tsc`
 * (`as const satisfies readonly (keyof T)[]`) and an upgrade that adds a
 * sibling fails `assertNoUnauditedKeys`. See
 * docs/architecture/05-native-ui-integration-contract.md.
 */
describe("host integration surface (native UI integration contract)", () => {
  /** Upstream slot components hang sub-components off a component object. */
  type SlotMembers<TSlot> = Exclude<keyof TSlot, "displayName" | "propTypes">;

  it("mounts only editor props that are already audited", () => {
    // excalidraw-editor.tsx is the only host that mounts the editor: the
    // published page renders a static `exportToSvg` output and passes no
    // editor props at all.
    const HOST_EDITOR_PROPS = [
      "children",
      "excalidrawAPI",
      "initialData",
      "isCollaborating",
      "langCode",
      "onChange",
      "onPointerUpdate",
      "renderCustomStats",
      "renderTopRightUI",
      "theme",
      "UIOptions",
      "validateEmbeddable",
      "viewModeEnabled",
    ] as const satisfies readonly (typeof EDITOR_PROP_KEYS)[number][];

    // The adapter's `ExcalidrawCanvasProps` must expose exactly this set: no
    // prop reaches the editor without passing through the audit above.
    type UnexposedHostProp = Exclude<
      (typeof HOST_EDITOR_PROPS)[number],
      keyof ExcalidrawCanvasProps
    >;
    type UnauditedAdapterProp = Exclude<
      keyof ExcalidrawCanvasProps,
      (typeof HOST_EDITOR_PROPS)[number]
    >;
    assertNoUnauditedKeys<UnexposedHostProp>();
    assertNoUnauditedKeys<UnauditedAdapterProp>();

    expect(HOST_EDITOR_PROPS).toHaveLength(13);
  });

  it("pins the upstream export utilities the host renders scenes through", () => {
    // The published page renders a static scene with `exportToSvg` instead of
    // mounting the editor, and lib/excalidraw.ts builds PNG thumbnails with
    // `exportToBlob`. Both are adapter passthroughs, so this is the runtime
    // tripwire for upstream dropping either one.
    expect(upstreamExportNames).toEqual(
      expect.arrayContaining(["exportToBlob", "exportToSvg"]),
    );
    expect(upstream.exportToSvg).toBeTypeOf("function");
  });

  it("calls only audited members of the imperative API", () => {
    const HOST_IMPERATIVE_API = [
      "addFiles",
      "getAppState",
      "getFiles",
      "getName",
      "getSceneElements",
      "getSceneElementsIncludingDeleted",
      "scrollToContent",
      "updateScene",
    ] as const satisfies readonly (typeof IMPERATIVE_API_KEYS)[number][];

    expect(HOST_IMPERATIVE_API).toHaveLength(8);
  });

  it("pins the UIOptions.canvasActions surface and the toggles the host sets", () => {
    const CANVAS_ACTION_KEYS = [
      "changeViewBackgroundColor",
      "clearCanvas",
      "export",
      "loadScene",
      "saveAsImage",
      "saveToActiveFile",
      "toggleTheme",
    ] as const satisfies readonly (keyof CanvasActions)[];
    type UnauditedCanvasAction = Exclude<
      keyof CanvasActions,
      (typeof CANVAS_ACTION_KEYS)[number]
    >;
    assertNoUnauditedKeys<UnauditedCanvasAction>();

    expect(CANVAS_ACTION_KEYS).toHaveLength(7);

    // The editor is the only host that sets any of them: it keeps upstream's
    // theme toggle and replaces the export UI. Everything else stays at the
    // upstream default.
    const HOST_CANVAS_ACTIONS = [
      "export",
      "toggleTheme",
    ] as const satisfies readonly (typeof CANVAS_ACTION_KEYS)[number][];
    expect(HOST_CANVAS_ACTIONS).toHaveLength(2);

    const EXPORT_OPT_KEYS = [
      "onExportToBackend",
      "renderCustomUI",
      "saveFileToDisk",
    ] as const satisfies readonly (keyof ExportOpts)[];
    type UnauditedExportOpt = Exclude<
      keyof ExportOpts,
      (typeof EXPORT_OPT_KEYS)[number]
    >;
    assertNoUnauditedKeys<UnauditedExportOpt>();

    const HOST_EXPORT_OPTS = [
      "renderCustomUI",
      "saveFileToDisk",
    ] as const satisfies readonly (typeof EXPORT_OPT_KEYS)[number][];
    expect(HOST_EXPORT_OPTS).toHaveLength(2);
  });

  it("pins the MainMenu slot the product features mount into", () => {
    const MAIN_MENU_SLOTS = [
      "DefaultItems",
      "Group",
      "Item",
      "ItemCustom",
      "ItemLink",
      "Separator",
      "Trigger",
    ] as const satisfies readonly SlotMembers<typeof MainMenu>[];
    type UnauditedMainMenuSlot = Exclude<
      SlotMembers<typeof MainMenu>,
      (typeof MAIN_MENU_SLOTS)[number]
    >;
    assertNoUnauditedKeys<UnauditedMainMenuSlot>();

    // app-main-menu.tsx and its item components.
    const HOST_MAIN_MENU_SLOTS = [
      "DefaultItems",
      "Item",
      "ItemCustom",
      "Separator",
    ] as const satisfies readonly (typeof MAIN_MENU_SLOTS)[number][];

    for (const slot of HOST_MAIN_MENU_SLOTS) {
      expect(MainMenu[slot]).toBeDefined();
    }
  });

  it("pins the MainMenu default items the menu renders", () => {
    type DefaultItems = typeof MainMenu.DefaultItems;

    const DEFAULT_ITEM_KEYS = [
      "ChangeCanvasBackground",
      "ClearCanvas",
      "CommandPalette",
      "Export",
      "Help",
      "LiveCollaborationTrigger",
      "LoadScene",
      "SaveAsImage",
      "SaveToActiveFile",
      "SearchMenu",
      "Socials",
      "ToggleTheme",
    ] as const satisfies readonly (keyof DefaultItems)[];
    type UnauditedDefaultItem = Exclude<
      keyof DefaultItems,
      (typeof DEFAULT_ITEM_KEYS)[number]
    >;
    assertNoUnauditedKeys<UnauditedDefaultItem>();

    const HOST_DEFAULT_ITEMS = [
      "ChangeCanvasBackground",
      "ClearCanvas",
      "Export",
      "Help",
      "LoadScene",
      "SaveAsImage",
      "SearchMenu",
      "ToggleTheme",
    ] as const satisfies readonly (typeof DEFAULT_ITEM_KEYS)[number][];

    for (const item of HOST_DEFAULT_ITEMS) {
      expect(MainMenu.DefaultItems[item]).toBeTypeOf("function");
    }

    // `ThemeItem` drives upstream's toggle in its three-state mode, which only
    // exists on the `allowSystemTheme: true` branch of the props union.
    type ToggleThemeProps = Parameters<DefaultItems["ToggleTheme"]>[0];
    const systemThemeProps: Extract<
      ToggleThemeProps,
      { allowSystemTheme: true }
    > = { allowSystemTheme: true, onSelect: () => undefined, theme: "system" };

    expect(systemThemeProps.theme).toBe("system");
  });

  it("pins the Footer, WelcomeScreen and Stats slots the host renders", () => {
    // `Footer` takes children only — there is nothing else to depend on.
    const FOOTER_SLOTS = [] as const satisfies readonly SlotMembers<
      typeof Footer
    >[];
    type UnauditedFooterSlot = Exclude<
      SlotMembers<typeof Footer>,
      (typeof FOOTER_SLOTS)[number]
    >;
    assertNoUnauditedKeys<UnauditedFooterSlot>();

    const WELCOME_SCREEN_SLOTS = [
      "Center",
      "Hints",
    ] as const satisfies readonly SlotMembers<typeof WelcomeScreen>[];
    type UnauditedWelcomeScreenSlot = Exclude<
      SlotMembers<typeof WelcomeScreen>,
      (typeof WELCOME_SCREEN_SLOTS)[number]
    >;
    assertNoUnauditedKeys<UnauditedWelcomeScreenSlot>();

    // app-welcome-screen.tsx renders each of these.
    const HOST_WELCOME_SCREEN_CENTER = [
      "Heading",
      "Logo",
      "Menu",
      "MenuItemHelp",
      "MenuItemLink",
      "MenuItemLoadScene",
    ] as const satisfies readonly SlotMembers<typeof WelcomeScreen.Center>[];
    const HOST_WELCOME_SCREEN_HINTS = [
      "HelpHint",
      "MenuHint",
      "ToolbarHint",
    ] as const satisfies readonly SlotMembers<typeof WelcomeScreen.Hints>[];

    for (const slot of HOST_WELCOME_SCREEN_CENTER) {
      expect(WelcomeScreen.Center[slot]).toBeDefined();
    }
    for (const slot of HOST_WELCOME_SCREEN_HINTS) {
      expect(WelcomeScreen.Hints[slot]).toBeDefined();
    }

    // custom-stats.tsx builds the `renderCustomStats` panel from these.
    const HOST_STATS_SLOTS = [
      "StatsRow",
      "StatsRows",
    ] as const satisfies readonly SlotMembers<typeof Stats>[];
    type UnauditedStatsSlot = Exclude<
      SlotMembers<typeof Stats>,
      (typeof HOST_STATS_SLOTS)[number]
    >;
    assertNoUnauditedKeys<UnauditedStatsSlot>();

    for (const slot of HOST_STATS_SLOTS) {
      expect(Stats[slot]).toBeTypeOf("function");
    }
  });

  it("has no public way to name the MainMenu trigger, which is the one accepted DOM workaround", () => {
    // `MainMenu` renders its own `DropdownMenu.Trigger` (dist/dev/index.js:
    // 17552-17565) with no accessible name (:10729-10761), and `DropdownMenu`
    // only picks a trigger out of its *own* children (:10889-10901), so a
    // host-rendered `MainMenu.Trigger` cannot replace it. That is why
    // apps/web/src/components/excalidraw/main-menu/accepted-limitation-trigger-label.ts
    // exists; this case is its removal condition.
    type MainMenuProps = Parameters<typeof MainMenu>[0];

    const MAIN_MENU_PROP_KEYS = [
      "__fallback",
      "children",
      "onSelect",
    ] as const satisfies readonly (keyof MainMenuProps)[];
    type UnauditedMainMenuProp = Exclude<
      keyof MainMenuProps,
      (typeof MAIN_MENU_PROP_KEYS)[number]
    >;
    assertNoUnauditedKeys<UnauditedMainMenuProp>();

    const mainMenuPropKeys: string[] = [...MAIN_MENU_PROP_KEYS];
    for (const missingProp of [
      "trigger",
      "renderTrigger",
      "triggerProps",
      "aria-label",
    ]) {
      expect(mainMenuPropKeys).not.toContain(missingProp);
    }
  });
});

describe("primary tools and active/locked tool state (public API)", () => {
  const DRAWSTUFF_PRIMARY_TOOLS = [
    "selection",
    "hand",
    "rectangle",
    "diamond",
    "ellipse",
    "arrow",
    "line",
    "freedraw",
    "text",
    "eraser",
  ] as const satisfies readonly ToolType[];

  it("expresses every planned primary tool as a typed setActiveTool command", () => {
    const { api, toolCommands } = createRecordingApi();

    for (const type of DRAWSTUFF_PRIMARY_TOOLS) {
      api.setActiveTool({ locked: true, type });
    }

    expect(toolCommands).toHaveLength(DRAWSTUFF_PRIMARY_TOOLS.length);
    expect(toolCommands.map((command) => command.type)).toEqual([
      ...DRAWSTUFF_PRIMARY_TOOLS,
    ]);
    expect(toolCommands.every((command) => command.locked === true)).toBe(true);
  });

  it("reads active and locked tool state from the public appState", () => {
    type ActiveToolState = ReturnType<
      ExcalidrawImperativeAPI["getAppState"]
    >["activeTool"];

    const activeToolFields = [
      "customType",
      "lastActiveTool",
      "locked",
      "type",
    ] as const satisfies readonly (keyof ActiveToolState)[];

    type UnauditedActiveToolField = Exclude<
      keyof ActiveToolState,
      (typeof activeToolFields)[number]
    >;
    assertNoUnauditedKeys<UnauditedActiveToolField>();

    expect(activeToolFields).toContain("locked");
  });
});

describe("style defaults (public API)", () => {
  const STYLE_DEFAULT_KEYS = [
    "currentItemArrowType",
    "currentItemBackgroundColor",
    "currentItemEndArrowhead",
    "currentItemFillStyle",
    "currentItemFontFamily",
    "currentItemFontSize",
    "currentItemOpacity",
    "currentItemRoughness",
    "currentItemRoundness",
    "currentItemStartArrowhead",
    "currentItemStrokeColor",
    "currentItemStrokeStyle",
    "currentItemStrokeWidth",
    "currentItemTextAlign",
  ] as const satisfies readonly (keyof AppState)[];

  it("patches new-element defaults through updateScene without touching elements", () => {
    const { api, sceneUpdates } = createRecordingApi();

    api.updateScene({
      appState: {
        currentItemStrokeColor: "#e03131",
        currentItemStrokeWidth: 4,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    expect(sceneUpdates).toEqual([
      {
        appState: {
          currentItemStrokeColor: "#e03131",
          currentItemStrokeWidth: 4,
        },
        captureUpdate: "IMMEDIATELY",
      },
    ]);
    expect(sceneUpdates[0]).not.toHaveProperty("elements");
    expect(STYLE_DEFAULT_KEYS).toHaveLength(14);
  });
});

describe("selected element actions (public API, O(n) accepted limitation)", () => {
  const selectedElementIds: Readonly<Record<string, true>> = { "rect-1": true };

  it("restyles the selection immutably and keeps unselected elements identical", () => {
    const nextElements = nativeElements.map((element) =>
      selectedElementIds[element.id]
        ? newElementWith(element, { strokeColor: "#e03131" })
        : element,
    );

    const original = nativeElements.find((element) => element.id === "rect-1");
    const restyled = nextElements.find((element) => element.id === "rect-1");

    expect(original?.strokeColor).toBe("#1e1e1e");
    expect(restyled?.strokeColor).toBe("#e03131");
    expect(restyled).not.toBe(original);
    expect(restyled?.version).toBe((original?.version ?? 0) + 1);
    expect(restyled?.versionNonce).not.toBe(original?.versionNonce);

    // No full-scene copy: untouched elements keep referential identity.
    nextElements.forEach((element, index) => {
      if (element.id !== "rect-1") {
        expect(element).toBe(nativeElements[index]);
      }
    });
  });

  it("reproduces the whole delete contract over public API only", () => {
    // Upstream's delete path runs `deleteSelectedElements` and then the
    // unexported `fixBindingsAfterDeletion`, so the host has to reimplement the
    // same obligations. Deleting `rect-1` must (a) tombstone `rect-1`,
    // (b) tombstone its bound text `text-1`, and (c) clear every binding that
    // pointed at `rect-1` — while leaving bindings to surviving elements and
    // every untouched element alone.
    const requested = new Set(["rect-1"]);

    // (b) a container's bound text has to go with it, or the scene keeps a
    // text element whose `containerId` dangles.
    const tombstoned = new Set(requested);
    for (const element of nativeElements) {
      if (
        element.type === "text" &&
        element.containerId !== null &&
        requested.has(element.containerId)
      ) {
        tombstoned.add(element.id);
      }
    }

    const nextElements = nativeElements.map((element) => {
      if (tombstoned.has(element.id)) {
        return newElementWith(element, { isDeleted: true });
      }

      // (c) a binding to a tombstoned element must be cleared; bindings to
      // survivors must not be touched.
      if (element.type === "arrow" || element.type === "line") {
        const clearStart =
          element.startBinding !== null &&
          tombstoned.has(element.startBinding.elementId);
        const clearEnd =
          element.endBinding !== null &&
          tombstoned.has(element.endBinding.elementId);

        if (clearStart || clearEnd) {
          return newElementWith(element, {
            startBinding: clearStart ? null : element.startBinding,
            endBinding: clearEnd ? null : element.endBinding,
          });
        }
      }

      return element;
    });

    const byId = new Map(nextElements.map((element) => [element.id, element]));

    // (a) + (b): both the container and its bound text are tombstoned, and the
    // source array is never mutated (`deleted-1` was already a tombstone).
    expect(byId.get("rect-1")?.isDeleted).toBe(true);
    expect(byId.get("text-1")?.isDeleted).toBe(true);
    expect(
      nativeElements
        .filter((element) => element.isDeleted)
        .map((element) => element.id),
    ).toEqual(["deleted-1"]);

    // (c): bindings that pointed at `rect-1` are cleared…
    // Clearing `line-1.startBinding` is a deliberate superset of upstream:
    // `bindableElementsVisitor` (chunk-4FTI6OG3.js:11845) only follows
    // `startBinding`/`endBinding` for `isArrowElement`, so upstream would leave
    // this synthetic fixture's `line` binding dangling.
    expect(findLinear(nextElements, "line-1").startBinding).toBeNull();
    expect(findLinear(nextElements, "arrow-1").startBinding).toBeNull();
    // …while the binding to the surviving `diamond-1` is preserved verbatim.
    expect(findLinear(nextElements, "arrow-1").endBinding).toEqual({
      elementId: "diamond-1",
      focus: -0.1,
      gap: 3,
      fixedPoint: [0, 0.5],
    });

    // Everything outside the deletion's blast radius keeps its identity, so a
    // delete command is still O(n) pointer copies rather than a deep clone.
    const touchedIds = new Set(["rect-1", "text-1", "line-1", "arrow-1"]);
    nextElements.forEach((element, index) => {
      if (!touchedIds.has(element.id)) {
        expect(element).toBe(nativeElements[index]);
      }
    });
  });

  it("prunes the survivor's boundElements when a bound child is deleted", () => {
    // The other half of `fixBindingsAfterDeletion`
    // (dist/dev/chunk-4FTI6OG3.js:11604): deleting a *bound* element runs
    // `BoundElement.unbindAffected` (:11873), which walks the deleted element's
    // bindable neighbours and filters it out of their `boundElements` via
    // `newBoundElements` (:11611, filter at :11615). Deleting `arrow-1` must
    // therefore prune it from `rect-1.boundElements` while leaving `text-1`
    // there. (`diamond-1`, the arrow's `endBinding` target, has a null
    // `boundElements`, so upstream's visitor produces no update for it.)
    const tombstoned = new Set(["arrow-1"]);

    const nextElements = nativeElements.map((element) => {
      if (tombstoned.has(element.id)) {
        return newElementWith(element, { isDeleted: true });
      }

      if (element.boundElements === null) {
        return element;
      }

      const nextBoundElements = element.boundElements.filter(
        (boundElement) => !tombstoned.has(boundElement.id),
      );

      return nextBoundElements.length === element.boundElements.length
        ? element
        : newElementWith(element, { boundElements: nextBoundElements });
    });

    const original = nativeElements.find((element) => element.id === "rect-1");
    const survivor = nextElements.find((element) => element.id === "rect-1");

    expect(
      nextElements.find((element) => element.id === "arrow-1")?.isDeleted,
    ).toBe(true);

    // The survivor is replaced by a new object holding a new array — the source
    // element and its `boundElements` array are never mutated in place.
    expect(survivor).not.toBe(original);
    expect(survivor?.boundElements).toEqual([{ id: "text-1", type: "text" }]);
    expect(survivor?.boundElements).not.toBe(original?.boundElements);
    expect(original?.boundElements).toHaveLength(2);
    expect(survivor?.version).toBe((original?.version ?? 0) + 1);

    // Everything else — including `diamond-1`, whose null `boundElements` makes
    // the prune a no-op — keeps referential identity.
    nextElements.forEach((element, index) => {
      if (element.id !== "arrow-1" && element.id !== "rect-1") {
        expect(element).toBe(nativeElements[index]);
      }
    });
  });

  it("has no exported binding-repair helper for the delete path", () => {
    // `fixBindingsAfterDeletion` stays module-private, which is why the
    // contract above has to be reimplemented (and pinned) host-side.
    expect(upstreamExportNames).not.toContain("fixBindingsAfterDeletion");
  });

  it("requires the deleted-inclusive getter, because updateScene replaces the whole scene", () => {
    // `updateScene({ elements })` calls `Scene.replaceAllElements`, so feeding it
    // `getSceneElements()` (non-deleted only) would silently drop tombstones and
    // break history/collaboration. Only the deleted-inclusive getter is safe.
    const imperativeApiKeys: string[] = [...IMPERATIVE_API_KEYS];

    expect(imperativeApiKeys).toContain("getSceneElementsIncludingDeleted");
    expect(imperativeApiKeys).toContain("getSceneElements");
  });
});

describe("text styling (public API with an accepted limitation)", () => {
  it("leaves text geometry stale, because newElementWith does not reflow", () => {
    const original = nativeElements.find((element) => element.id === "text-1");
    if (original?.type !== "text") {
      throw new Error("fixture must contain the text element text-1");
    }

    const resized = newElementWith(original, {
      fontSize: original.fontSize * 2,
    });

    expect(resized.fontSize).toBe(40);
    // Upstream's own `changeFontSize` follows `newElementWith` with
    // `redrawTextBoundingBox` and then `updateBoundElements`
    // (dist/dev/index.js:4321). `newElementWith` alone only copies the patch,
    // so width/height still describe the 20px text.
    expect(resized.width).toBe(original.width);
    expect(resized.height).toBe(original.height);
  });

  it("does not export the reflow helpers, leaving restoreElements as the only public recipe", () => {
    // `Object.keys(upstream)` is a real module-namespace read, so this loop is
    // the tripwire that fires when upstream starts exporting any of these.
    for (const reflowHelper of [
      "redrawTextBoundingBox",
      "updateBoundElements",
      // The pieces a host would need to reimplement `redrawTextBoundingBox`
      // itself — see the G4 suite below.
      "computeBoundTextPosition",
      "computeContainerDimensionForBoundText",
      "getBoundTextMaxWidth",
      "getContainerElement",
      "getFontString",
      "measureText",
      "wrapText",
    ]) {
      expect(upstreamExportNames).not.toContain(reflowHelper);
    }

    // `restoreElements(elements, null, { repairBindings: true,
    // refreshDimensions: true })` is the only public call that recomputes text
    // dimensions, at three costs: it rebuilds every element object (so
    // untouched elements lose referential identity), it never calls
    // `updateBoundElements` (so arrows bound to a resized text stay stale), and
    // its `refreshTextDimensions` re-wraps from `text` rather than
    // `originalText` while never touching the container — that third cost is
    // gap G4.
    expect(upstreamExportNames).toContain("restoreElements");
  });
});

describe("container-bound text reflow (confirmed gap G4)", () => {
  const boundText = findBoundText(nativeElements, "text-1");
  const container = nativeElements.find((element) => element.id === "rect-1");

  it("can reset the wrap source to originalText over public API", () => {
    // Upstream's `redrawTextBoundingBox` always wraps from `originalText`
    // (chunk-4FTI6OG3.js:14574), but restore's `refreshTextDimensions`
    // (:15252) defaults its `text` argument to `textElement.text` — the
    // already hard-wrapped string — so repeated font-size changes are not
    // idempotent. A previous reflow is simulated here by a hard-wrapped `text`.
    const wrapped = newElementWith(boundText, { text: "Bound\ntext" });

    const naive = newElementWith(wrapped, { fontSize: wrapped.fontSize * 2 });
    const mitigated = newElementWith(wrapped, {
      fontSize: wrapped.fontSize * 2,
      text: wrapped.originalText,
    });

    // Without the mitigation, restore would re-wrap the already-wrapped text.
    expect(naive.text).toBe("Bound\ntext");
    // With it, restore starts from the same source upstream uses.
    expect(mitigated.text).toBe(boundText.originalText);
    expect(mitigated.originalText).toBe(boundText.originalText);
    expect(mitigated.fontSize).toBe(40);
  });

  it("has no public way to resize the container or reposition the bound text", () => {
    // The wrap-source half above is fixable host-side; the geometry half is
    // not. `redrawTextBoundingBox` grows the container through
    // `computeContainerDimensionForBoundText` (chunk-4FTI6OG3.js:14595, :14603)
    // and then repositions the text with `computeBoundTextPosition` (:14613).
    // `refreshTextDimensions` (:15252) returns `{ text, ...dimensions }` for
    // the text element only and never touches the container, and every helper
    // named above is unexported (pinned in the #4a suite). So the strongest
    // executable claim is this: a public-API font-size command leaves the
    // container geometry exactly as it was.
    const restyled = newElementWith(boundText, {
      fontSize: boundText.fontSize * 2,
    });
    const nextElements = nativeElements.map((element) =>
      element.id === boundText.id ? restyled : element,
    );

    const untouchedContainer = nextElements.find(
      (element) => element.id === "rect-1",
    );

    expect(restyled.containerId).toBe("rect-1");
    // The container is not even in the patch's blast radius, so it keeps both
    // its stale dimensions and its referential identity.
    expect(untouchedContainer).toBe(container);
    expect(container?.width).toBe(180);
    expect(container?.height).toBe(100);

    // Nor is there a container-aware entrypoint anywhere on the public surface.
    const imperativeApiKeys: string[] = [...IMPERATIVE_API_KEYS];
    for (const missingCommand of [
      "redrawBoundText",
      "refreshTextDimensions",
      "reflowBoundText",
    ]) {
      expect(imperativeApiKeys).not.toContain(missingCommand);
      expect(upstreamExportNames).not.toContain(missingCommand);
    }
  });
});

describe("undo/redo (confirmed gap)", () => {
  it("exposes only history.clear, with no host-invocable undo or redo", () => {
    type HistoryApi = ExcalidrawImperativeAPI["history"];

    const historyKeys = [
      "clear",
    ] as const satisfies readonly (keyof HistoryApi)[];
    type UnauditedHistoryKey = Exclude<
      keyof HistoryApi,
      (typeof historyKeys)[number]
    >;
    assertNoUnauditedKeys<UnauditedHistoryKey>();

    expect(historyKeys).toEqual(["clear"]);
  });

  it("has no undo/redo command on the imperative API or the module surface", () => {
    const imperativeApiKeys: string[] = [...IMPERATIVE_API_KEYS];

    for (const command of ["undo", "redo", "executeAction"]) {
      expect(imperativeApiKeys).not.toContain(command);
      expect(upstreamExportNames).not.toContain(command);
    }

    // `registerAction` can add an action but cannot invoke one, so the only
    // remaining trigger is a synthetic keyboard event on the editor container —
    // a DOM-level workaround the native UI integration contract forbids in
    // production code (docs/architecture/05-native-ui-integration-contract.md
    // §禁止事項).
    expect(imperativeApiKeys).toContain("registerAction");
  });
});

describe("hiding or replacing the upstream toolbar (confirmed gap)", () => {
  type EditorUIOptions = NonNullable<ExcalidrawProps["UIOptions"]>;

  it("offers no UIOptions switch for the primary tool island", () => {
    const uiOptionKeys = [
      "canvasActions",
      "dockedSidebarBreakpoint",
      "tools",
      "welcomeScreen",
    ] as const satisfies readonly (keyof EditorUIOptions)[];

    type UnauditedUIOptionKey = Exclude<
      keyof EditorUIOptions,
      (typeof uiOptionKeys)[number]
    >;
    assertNoUnauditedKeys<UnauditedUIOptionKey>();
    const optionKeys: string[] = [...uiOptionKeys];

    for (const missingOption of [
      "shapes",
      "toolbar",
      "tools.shapes",
      "primaryTools",
    ]) {
      expect(optionKeys).not.toContain(missingOption);
    }
  });

  it("can only hide the image tool, not the rest of the shape switcher", () => {
    type ToolsOption = NonNullable<EditorUIOptions["tools"]>;

    const toolToggles = [
      "image",
    ] as const satisfies readonly (keyof ToolsOption)[];
    type UnauditedToolToggle = Exclude<
      keyof ToolsOption,
      (typeof toolToggles)[number]
    >;
    assertNoUnauditedKeys<UnauditedToolToggle>();

    expect(toolToggles).toEqual(["image"]);
  });

  it("leaves viewModeEnabled and zenModeEnabled as the only visibility props", () => {
    // `viewModeEnabled` hides the toolbar but also disables editing, and
    // `zenModeEnabled` only translates the properties panel, the top-right UI
    // and the host `Footer` slot off-screen while the tool island stays put.
    const editorPropKeys: string[] = [...EDITOR_PROP_KEYS];

    expect(editorPropKeys).toContain("viewModeEnabled");
    expect(editorPropKeys).toContain("zenModeEnabled");
    expect(editorPropKeys).not.toContain("renderToolbar");
  });
});

describe("mobile UI (public API with an accepted limitation)", () => {
  it("reports the mobile breakpoint through renderTopRightUI", () => {
    type RenderTopRightUI = NonNullable<ExcalidrawProps["renderTopRightUI"]>;
    const isMobile: Parameters<RenderTopRightUI>[0] = true;

    expect(isMobile).toBe(true);
    expect(upstreamExportNames).toContain("useDevice");
  });

  it("has no prop that renders the host Footer slot on mobile", () => {
    // `LayerUI` renders `FooterCenterTunnel.Out` only in the desktop branch, so
    // `<ExcalidrawFooter>` children are unmounted on mobile. The custom toolbar
    // must therefore use `renderTopRightUI` / `MainMenu` for the mobile layout.
    const editorPropKeys: string[] = [...EDITOR_PROP_KEYS];

    for (const missingProp of ["renderFooter", "mobileBreakpoint", "device"]) {
      expect(editorPropKeys).not.toContain(missingProp);
    }
  });
});

describe("collaboration state (public API)", () => {
  it("publishes collaborators without entering the undo stack", () => {
    const { api, sceneUpdates } = createRecordingApi();
    const collaborators = new Map<SocketId, Collaborator>([
      ["socket-1" as SocketId, { username: "peer" }],
    ]);

    api.updateScene({
      captureUpdate: CaptureUpdateAction.NEVER,
      collaborators,
    });

    expect(sceneUpdates).toEqual([{ captureUpdate: "NEVER", collaborators }]);
  });

  it("covers every collaboration input the host needs", () => {
    const collaborationProps = [
      "isCollaborating",
      "onChange",
      "onPointerUpdate",
      "onUserFollow",
    ] as const satisfies readonly (keyof ExcalidrawProps)[];

    expect([...collaborationProps]).toHaveLength(4);
    expect(upstreamExportNames).toEqual(
      expect.arrayContaining([
        "UserIdleState",
        "getSceneVersion",
        "hashElementsVersion",
        "reconcileElements",
      ]),
    );
  });
});

describe("change notification cost (accepted limitation)", () => {
  it("offers a single coarse onChange subscription and nothing more granular", () => {
    // `App.componentDidUpdate` triggers `onChange` after *every* re-render, so
    // the controller must derive a semantic snapshot and dedupe itself. The
    // payload is the live scene array, so upstream never copies the scene.
    const imperativeApiKeys: string[] = [...IMPERATIVE_API_KEYS];

    expect(imperativeApiKeys).toContain("onChange");
    for (const missingSubscription of [
      "onSelectionChange",
      "onActiveToolChange",
      "onHistoryChange",
      "onStoreIncrement",
    ]) {
      expect(imperativeApiKeys).not.toContain(missingSubscription);
    }
  });

  it("keeps onPointerUpdate off the change channel so it can be throttled by the host", () => {
    const editorPropKeys: string[] = [...EDITOR_PROP_KEYS];

    expect(editorPropKeys).toContain("onPointerUpdate");
    expect(upstreamExportNames).not.toContain("onStoreIncrementEmitter");
  });
});

describe("embeddable allowlist (no gap) and its rejection toast (confirmed gap)", () => {
  it("types the host-side validator as extend-only", () => {
    const extendAllowlist = (link: string): boolean | undefined =>
      link.startsWith("https://drawstuff.example/") ? true : undefined;
    const validateEmbeddable: ExcalidrawValidateEmbeddable = extendAllowlist;

    expect(validateEmbeddable).toBe(extendAllowlist);
    expect(extendAllowlist("https://drawstuff.example/board")).toBe(true);
    expect(extendAllowlist("https://youtube.com/watch")).toBeUndefined();
    // This case pins *our* validator's shape only. That returning `undefined`
    // makes upstream fall through to its built-in ALLOWED_DOMAINS is
    // source-verified (dist/dev/chunk-4FTI6OG3.js:17284-17311), not executed
    // here — the next case shows why it cannot be.
  });

  it("cannot reach embeddableURLValidator from any published entrypoint", () => {
    expect(upstreamExportNames).not.toContain("embeddableURLValidator");
    // The `./*` subpath in the upstream export map declares a `types`
    // condition and nothing else, so the validator is type-visible (this file
    // imports `@excalidraw/excalidraw/element/types` for exactly that reason)
    // but has no runtime resolution at all. Docs §#9 therefore rests on
    // source-level evidence and must be re-read by hand on every upgrade.
    expect(() =>
      requireFromTest.resolve("@excalidraw/excalidraw/element/embeddable"),
    ).toThrow();
  });

  it("cannot override the toast.unableToEmbed copy for a single locale key", () => {
    const editorPropKeys: string[] = [...EDITOR_PROP_KEYS];

    type LocaleProp = Extract<
      keyof ExcalidrawProps,
      `lang${string}` | `locale${string}` | `translat${string}`
    >;
    const localeProps = ["langCode"] as const satisfies readonly LocaleProp[];
    type UnauditedLocaleProp = Exclude<
      LocaleProp,
      (typeof localeProps)[number]
    >;
    assertNoUnauditedKeys<UnauditedLocaleProp>();

    // Runtime counterpart of the `satisfies readonly LocaleProp[]` pin above:
    // every audited locale prop must still exist on the upstream editor props.
    expect([...localeProps]).toEqual(["langCode"]);
    for (const auditedLocaleProp of localeProps) {
      expect(editorPropKeys).toContain(auditedLocaleProp);
    }
    for (const missingOverride of [
      "locale",
      "translations",
      "i18n",
      "messages",
    ]) {
      expect(editorPropKeys).not.toContain(missingOverride);
    }
    // `setLanguage` / `t` stay module-private, so the toast copy shipped by the
    // en locale is the only string a rejected embed can ever show.
    expect(upstreamExportNames).not.toContain("setLanguage");
    expect(upstreamExportNames).toContain("useI18n");
  });
});
