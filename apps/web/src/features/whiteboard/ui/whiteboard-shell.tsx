"use client";

import {
  ArrowRight,
  ArrowDown,
  ArrowUp,
  BringToFront,
  Circle,
  Diamond,
  Download,
  Ellipsis,
  Eraser,
  FilePenLine,
  FileUp,
  Frame,
  Hand,
  HelpCircle,
  Image,
  Lock,
  Menu,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  Save,
  Scan,
  SendToBack,
  Settings2,
  Share2,
  Slash,
  Square,
  SquareRoundCorner,
  Type,
  Undo2,
  Unlock,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { StorageWarning } from "@/components/storage-warning";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SCENE_FILE_IMPORT_MAX_BYTES } from "@/config/app-constants";
import type {
  OwnedWhiteboardEditorState,
  WhiteboardEdgeStyle,
  WhiteboardElementStyle,
  WhiteboardEngine,
  WhiteboardFillStyle,
  WhiteboardStrokeStyle,
  WhiteboardTheme,
  WhiteboardTool,
  WhiteboardToolType,
} from "@drawstuff/whiteboard";
import { OWNED_DARK_THEME_FILTER } from "@drawstuff/whiteboard";
import { triggerBlobDownload } from "@/lib/download";
import { cn } from "@/lib/utils";

type Icon = ComponentType<React.ComponentProps<"svg">>;

type ToolDefinition = {
  readonly type: WhiteboardToolType;
  readonly label: string;
  readonly shortcut: string;
  readonly keys: readonly string[];
  readonly icon: Icon;
};

const TOOLS: readonly ToolDefinition[] = [
  { type: "hand", label: "Hand", shortcut: "H", keys: ["h"], icon: Hand },
  {
    type: "selection",
    label: "Selection",
    shortcut: "1",
    keys: ["1", "v"],
    icon: MousePointer2,
  },
  {
    type: "rectangle",
    label: "Rectangle",
    shortcut: "2",
    keys: ["2", "r"],
    icon: Square,
  },
  {
    type: "diamond",
    label: "Diamond",
    shortcut: "3",
    keys: ["3", "d"],
    icon: Diamond,
  },
  {
    type: "ellipse",
    label: "Ellipse",
    shortcut: "4",
    keys: ["4", "o"],
    icon: Circle,
  },
  {
    type: "arrow",
    label: "Arrow",
    shortcut: "5",
    keys: ["5", "a"],
    icon: ArrowRight,
  },
  {
    type: "line",
    label: "Line",
    shortcut: "6",
    keys: ["6", "l"],
    icon: Slash,
  },
  {
    type: "freedraw",
    label: "Draw",
    shortcut: "7",
    keys: ["7", "p", "x"],
    icon: Pencil,
  },
  { type: "text", label: "Text", shortcut: "8", keys: ["8", "t"], icon: Type },
  {
    type: "image",
    label: "Insert image",
    shortcut: "9",
    keys: ["9"],
    icon: Image,
  },
  {
    type: "eraser",
    label: "Eraser",
    shortcut: "0",
    keys: ["0", "e"],
    icon: Eraser,
  },
  { type: "frame", label: "Frame", shortcut: "F", keys: ["f"], icon: Frame },
] as const;

const EXTRA_TOOL_TYPES = new Set(["frame"]);
const PRIMARY_TOOLS = TOOLS.filter((tool) => !EXTRA_TOOL_TYPES.has(tool.type));
const EXTRA_TOOLS = TOOLS.filter((tool) => EXTRA_TOOL_TYPES.has(tool.type));
const MOBILE_TOOL_TYPES = new Set([
  "hand",
  "selection",
  "freedraw",
  "eraser",
  "rectangle",
  "arrow",
  "text",
]);
const MOBILE_EXTRA_TOOLS = TOOLS.filter(
  (tool) => !MOBILE_TOOL_TYPES.has(tool.type),
);
const MOBILE_TOOL_CLASSES: Readonly<Record<string, string>> = {
  hand: "order-1 md:order-none",
  selection: "order-2 md:order-none",
  freedraw: "order-3 md:order-none",
  eraser: "order-4 md:order-none",
  rectangle: "order-5 md:order-none",
  arrow: "order-6 md:order-none",
  text: "order-7 md:order-none",
};
const LOCKABLE_TOOL_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "frame",
]);
const NON_STYLE_TOOLS = new Set(["selection", "hand", "eraser", "frame"]);

const TOOL_SHORTCUTS = new Map(
  TOOLS.flatMap((tool) => tool.keys.map((key) => [key, tool.type] as const)),
);

const STROKE_COLORS = [
  "#1e1e1e",
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
] as const;
const FILL_COLORS = [
  "transparent",
  "#ffc9c9",
  "#b2f2bb",
  "#a5d8ff",
  "#ffec99",
] as const;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

const DISCONNECTED_STATE: OwnedWhiteboardEditorState = {
  activeTool: { type: "selection", locked: false },
  toolLocked: false,
  interaction: "idle",
  viewport: {
    x: 0,
    y: 0,
    zoom: 1,
    width: 0,
    height: 0,
    offsetX: 0,
    offsetY: 0,
  },
  name: "",
  theme: "light",
  selectedElementIds: [],
  selection: { elementIds: [], groupIds: [], editingGroupId: null },
  elementStyle: {
    strokeColor: STROKE_COLORS[0],
    backgroundColor: FILL_COLORS[0],
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roundness: "round",
  },
  selectionStyle: null,
  canUndo: false,
  canRedo: false,
  canGroup: false,
  canUngroup: false,
};

export type WhiteboardShellProps = {
  readonly children: ReactNode;
  readonly engine: WhiteboardEngine | null;
  readonly sceneName: string;
  readonly isSaving?: boolean;
  readonly isSharing?: boolean;
  readonly productMenuContent?: ReactNode;
  readonly onRename: () => void;
  readonly onSave: () => void;
  readonly onShare: () => void;
  readonly onWorkspace?: () => void;
  readonly onImported?: (name: string | null) => void;
};

export function WhiteboardShell({
  children,
  engine,
  sceneName,
  isSaving = false,
  isSharing = false,
  productMenuContent,
  onRename,
  onSave,
  onShare,
  onWorkspace,
  onImported,
}: WhiteboardShellProps) {
  const editorState = useWhiteboardEditorState(engine);
  const [helpOpen, setHelpOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [isDocumentEmpty, setIsDocumentEmpty] = useState(true);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const showProperties = canShowProperties(editorState);

  useEffect(() => {
    if (!engine) {
      setIsDocumentEmpty(true);
      return;
    }
    const update = (document: ReturnType<WhiteboardEngine["getDocument"]>) =>
      setIsDocumentEmpty(
        !document.elements.some((element) => !element.isDeleted),
      );
    update(engine.getDocument());
    return engine.subscribeDocument(update);
  }, [engine]);

  const selectTool = useCallback(
    (type: WhiteboardToolType) => {
      if (type === "image" && engine?.insertImage) {
        imageInputRef.current?.click();
        return;
      }
      engine?.setActiveTool({ type });
    },
    [engine],
  );

  const zoomBy = useCallback(
    (delta: number) => {
      if (!engine) return;
      const current = engine.getViewport().zoom;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + delta));
      engine.updateViewport({ zoom });
    },
    [engine],
  );

  const resetZoom = useCallback(() => {
    engine?.updateViewport({ zoom: 1 });
  }, [engine]);

  const fitToContent = useCallback(() => {
    engine?.fitToContent({ animate: true, fitToViewport: true });
  }, [engine]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (
        !engine ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat
      )
        return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "0") {
        event.preventDefault();
        event.stopPropagation();
        resetZoom();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const tool = TOOL_SHORTCUTS.get(key);
      const isShellShortcut =
        Boolean(tool) ||
        key === "?" ||
        key === "+" ||
        key === "=" ||
        key === "-";
      if (
        isShellShortcut &&
        (helpOpen || importOpen || exportOpen || propertiesOpen || clearOpen)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (tool) {
        event.preventDefault();
        event.stopPropagation();
        const activeTool = engine.getActiveTool().type;
        const nextTool =
          (tool === "hand" || tool === "eraser") && activeTool === tool
            ? "selection"
            : tool;
        selectTool(nextTool);
        return;
      }
      if (key === "?") {
        event.preventDefault();
        event.stopPropagation();
        engine.updateEditorState({ openDialog: null });
        setHelpOpen(true);
        return;
      }
      if (key === "+" || key === "=") {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (key === "-") {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(-ZOOM_STEP);
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    clearOpen,
    engine,
    exportOpen,
    helpOpen,
    importOpen,
    propertiesOpen,
    resetZoom,
    selectTool,
    zoomBy,
  ]);

  const clearCanvas = useCallback(() => {
    engine?.clearDocument();
    setClearOpen(false);
  }, [engine]);

  const importImage = useCallback(
    async (file: File | null) => {
      if (!engine?.insertImage || !file) return;
      try {
        await engine.insertImage(file);
        toast.success("Image added");
      } catch (error) {
        console.error(error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not import this image",
        );
      } finally {
        if (imageInputRef.current) imageInputRef.current.value = "";
      }
    },
    [engine],
  );

  return (
    <TooltipProvider>
      <ContextMenu>
        <ContextMenuTrigger
          className={cn(
            "whiteboard-shell relative isolate h-full w-full overflow-hidden bg-[var(--whiteboard-surface-lowest)]",
            getCanvasCursorClass(editorState.activeTool.type),
          )}
          data-canvas-theme={editorState.theme}
          onContextMenu={() =>
            engine?.updateEditorState({
              contextMenu: null,
              openMenu: null,
            })
          }
        >
          {children}
          <div
            className="pointer-events-none absolute inset-0 z-10"
            onContextMenu={(event) => event.stopPropagation()}
          >
            {isDocumentEmpty && (
              <section
                aria-label="Welcome to Drawstuff"
                className="pointer-events-auto absolute top-1/2 left-1/2 flex w-[min(26rem,calc(100%_-_2rem))] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-4 rounded-xl bg-[var(--whiteboard-island)] p-6 text-center shadow-[var(--whiteboard-shadow)]"
              >
                <div className="flex flex-col gap-1">
                  <h1 className="text-lg font-semibold">Start drawing</h1>
                  <p className="text-muted-foreground text-sm">
                    Open a V3 board or create something new on the canvas.
                  </p>
                </div>
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
                  <Button onClick={() => setImportOpen(true)} variant="outline">
                    <FileUp data-icon="inline-start" />
                    Open V3 file
                  </Button>
                  <Button
                    onClick={() => {
                      if (onWorkspace) onWorkspace();
                      else window.location.assign("/login");
                    }}
                    variant="outline"
                  >
                    {onWorkspace ? "Browse Workspace" : "Sign in"}
                  </Button>
                  <Button onClick={() => setHelpOpen(true)} variant="ghost">
                    <HelpCircle data-icon="inline-start" />
                    Help & shortcuts
                  </Button>
                </div>
              </section>
            )}

            <TopBar
              connected={Boolean(engine)}
              isSaving={isSaving}
              isSharing={isSharing}
              productMenuContent={productMenuContent}
              sceneName={sceneName}
              onClear={() => setClearOpen(true)}
              onExport={() => setExportOpen(true)}
              onHelp={() => setHelpOpen(true)}
              onImport={() => setImportOpen(true)}
              onRename={onRename}
              onSave={onSave}
              onShare={onShare}
              onWorkspace={onWorkspace}
            />

            <DrawingToolbar
              activeTool={editorState.activeTool}
              disabled={!engine}
              onSelectTool={selectTool}
              onToggleLock={() => {
                const activeTool = editorState.activeTool;
                engine?.setToolLocked(!activeTool.locked);
              }}
              onLockTool={(type) =>
                engine?.setActiveTool({ type, locked: true })
              }
            />

            {showProperties && (
              <div className="pointer-events-auto absolute top-[4.75rem] left-4 hidden lg:block">
                <PropertiesPanel engine={engine} editorState={editorState} />
              </div>
            )}

            <div className="pointer-events-auto absolute right-3 bottom-[4.75rem] left-3 lg:hidden">
              <MobileProperties
                engine={engine}
                editorState={editorState}
                open={propertiesOpen}
                showProperties={showProperties}
                onRedo={() => engine?.redo()}
                onUndo={() => engine?.undo()}
                onOpenChange={setPropertiesOpen}
              />
            </div>

            <ViewportControls
              disabled={!engine}
              zoom={editorState.viewport.zoom}
              onRedo={() => engine?.redo()}
              onReset={resetZoom}
              onUndo={() => engine?.undo()}
              onZoomIn={() => zoomBy(ZOOM_STEP)}
              onZoomOut={() => zoomBy(-ZOOM_STEP)}
            />

            <div className="pointer-events-auto absolute right-4 bottom-4 hidden md:block">
              <TooltipButton
                icon={HelpCircle}
                label="Help"
                onClick={() => setHelpOpen(true)}
                size="whiteboard-tool"
                variant="whiteboard-control"
              />
            </div>
          </div>
        </ContextMenuTrigger>

        <CanvasContextMenu
          disabled={!engine}
          onClear={() => setClearOpen(true)}
          onFit={fitToContent}
          onRedo={() => engine?.redo()}
          onUndo={() => engine?.undo()}
        />
      </ContextMenu>

      <ImportDialog
        engine={engine}
        open={importOpen}
        onImported={onImported}
        onOpenChange={setImportOpen}
      />
      <ExportDialog
        engine={engine}
        hasSelection={editorState.selectedElementIds.length > 0}
        sceneName={sceneName}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
      <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <ClearCanvasDialog
        open={clearOpen}
        onConfirm={clearCanvas}
        onOpenChange={setClearOpen}
      />
      <Input
        ref={imageInputRef}
        accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
        aria-label="Import image"
        hidden
        onChange={(event) =>
          void importImage(event.currentTarget.files?.[0] ?? null)
        }
        tabIndex={-1}
        type="file"
      />
    </TooltipProvider>
  );
}

function useWhiteboardEditorState(
  engine: WhiteboardEngine | null,
): OwnedWhiteboardEditorState {
  const [state, setState] =
    useState<OwnedWhiteboardEditorState>(DISCONNECTED_STATE);

  useEffect(() => {
    if (!engine) {
      setState(DISCONNECTED_STATE);
      return;
    }
    setState(engine.getEditorState());
    return engine.subscribeEditorState(setState);
  }, [engine]);

  return state;
}

function canShowProperties(editorState: OwnedWhiteboardEditorState): boolean {
  return (
    editorState.selectedElementIds.length > 0 ||
    !NON_STYLE_TOOLS.has(editorState.activeTool.type)
  );
}

function getCanvasCursorClass(tool: string): string {
  if (tool === "hand") return "cursor-grab";
  if (tool === "selection") return "cursor-default";
  if (tool === "eraser") return "cursor-cell";
  return "cursor-crosshair";
}

type TopBarProps = {
  readonly connected: boolean;
  readonly isSaving: boolean;
  readonly isSharing: boolean;
  readonly productMenuContent?: ReactNode;
  readonly sceneName: string;
  readonly onClear: () => void;
  readonly onExport: () => void;
  readonly onHelp: () => void;
  readonly onImport: () => void;
  readonly onRename: () => void;
  readonly onSave: () => void;
  readonly onShare: () => void;
  readonly onWorkspace?: () => void;
};

function TopBar({
  connected,
  isSaving,
  isSharing,
  productMenuContent,
  sceneName,
  onClear,
  onExport,
  onHelp,
  onImport,
  onRename,
  onSave,
  onShare,
  onWorkspace,
}: TopBarProps) {
  return (
    <header className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3 md:inset-x-4 md:top-4">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label="Main menu"
                    className="pointer-events-auto size-8 md:size-9"
                    size="whiteboard-tool"
                    variant="whiteboard-control"
                  />
                }
              />
            }
          >
            <Menu />
          </TooltipTrigger>
          <TooltipContent>Main menu</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate">
              {sceneName || "Untitled"}
            </DropdownMenuLabel>
            <DropdownMenuItem disabled={!connected} onClick={onImport}>
              <FileUp />
              Import
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!connected} onClick={onExport}>
              <Download />
              Export
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!connected} onClick={onRename}>
              <FilePenLine />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!connected || isSaving}
              onClick={onSave}
            >
              <Save />
              Save to cloud
              <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!connected || isSharing}
              onClick={onShare}
            >
              <Share2 />
              Share
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={!onWorkspace}
              onClick={() => onWorkspace?.()}
            >
              <Settings2 />
              Workspace settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {productMenuContent}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <div className="px-2 py-1.5" role="none">
              <StorageWarning className="flex items-center" />
            </div>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!connected} onClick={onClear}>
              Clear canvas
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onHelp}>
              <HelpCircle />
              Keyboard shortcuts
              <DropdownMenuShortcut>?</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="pointer-events-auto flex items-center gap-2">
        <TooltipButton
          className="hidden md:inline-flex"
          disabled={!connected || isSaving}
          icon={Save}
          label={isSaving ? "Saving" : "Save"}
          onClick={onSave}
          size="whiteboard-tool"
          variant="whiteboard-control"
        />
        <Button
          aria-label={isSharing ? "Sharing" : "Share"}
          className="size-8 px-0 md:h-9 md:w-auto md:px-3"
          disabled={!connected || isSharing}
          onClick={onShare}
          size="whiteboard-share"
          variant="whiteboard-primary"
        >
          <Share2 data-icon="inline-start" />
          <span className="hidden md:inline">
            {isSharing ? "Sharing" : "Share"}
          </span>
        </Button>
      </div>
    </header>
  );
}

type DrawingToolbarProps = {
  readonly activeTool: WhiteboardTool;
  readonly disabled: boolean;
  readonly onSelectTool: (type: WhiteboardToolType) => void;
  readonly onLockTool: (type: WhiteboardToolType) => void;
  readonly onToggleLock: () => void;
};

function DrawingToolbar({
  activeTool,
  disabled,
  onSelectTool,
  onLockTool,
  onToggleLock,
}: DrawingToolbarProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabStopTool = TOOLS.some((tool) => tool.type === activeTool.type)
    ? activeTool.type
    : "selection";
  const activeExtraTool = EXTRA_TOOLS.find(
    (tool) => tool.type === activeTool.type,
  );
  const activeMobileExtraTool = MOBILE_EXTRA_TOOLS.find(
    (tool) => tool.type === activeTool.type,
  );
  const DesktopExtraToolIcon = activeExtraTool?.icon ?? Ellipsis;
  const MobileExtraToolIcon = activeMobileExtraTool?.icon ?? Ellipsis;
  const canLock = LOCKABLE_TOOL_TYPES.has(activeTool.type);

  function moveFocus(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    const lastIndex = PRIMARY_TOOLS.length;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = index === lastIndex ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = index === 0 ? lastIndex : index - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    buttonRefs.current[nextIndex]?.focus();
  }

  return (
    <div
      aria-label="Drawing tools"
      className="pointer-events-auto absolute inset-x-3 bottom-2 flex max-w-[calc(100%_-_1.5rem)] items-center justify-between gap-1 overflow-hidden rounded-lg bg-[var(--whiteboard-island)] p-1 shadow-[var(--whiteboard-shadow)] md:inset-x-auto md:top-4 md:bottom-auto md:left-1/2 md:-translate-x-1/2 md:justify-start md:overflow-visible"
      role="toolbar"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={
                activeTool.locked
                  ? "Unlock tool"
                  : "Keep selected tool active after drawing"
              }
              aria-pressed={Boolean(activeTool.locked)}
              className="hidden md:inline-flex"
              disabled={disabled || !canLock}
              onClick={onToggleLock}
              size="whiteboard-tool"
              tabIndex={-1}
              variant={activeTool.locked ? "whiteboard-active" : "whiteboard"}
            />
          }
        >
          {activeTool.locked ? <Unlock /> : <Lock />}
        </TooltipTrigger>
        <TooltipContent>
          {activeTool.locked
            ? "Unlock tool"
            : "Keep selected tool active after drawing"}
        </TooltipContent>
      </Tooltip>

      <div
        aria-hidden="true"
        className="mx-0.5 hidden h-6 w-px shrink-0 bg-[var(--whiteboard-surface-high)] md:block"
      />

      {PRIMARY_TOOLS.map((tool, index) => (
        <Tooltip key={tool.type}>
          <TooltipTrigger
            render={
              <Button
                aria-label={tool.label}
                aria-pressed={activeTool.type === tool.type}
                className={cn(
                  MOBILE_TOOL_CLASSES[tool.type],
                  !MOBILE_TOOL_TYPES.has(tool.type) && "hidden md:inline-flex",
                )}
                disabled={disabled}
                onKeyDown={(event) => moveFocus(event, index)}
                onClick={() => onSelectTool(tool.type)}
                onDoubleClick={() => onLockTool(tool.type)}
                ref={(button) => {
                  buttonRefs.current[index] = button;
                }}
                size="whiteboard-tool"
                tabIndex={tabStopTool === tool.type ? 0 : -1}
                variant={
                  activeTool.type === tool.type
                    ? "whiteboard-active"
                    : "whiteboard"
                }
              />
            }
          >
            <tool.icon />
            <span
              aria-hidden="true"
              className="absolute right-1 bottom-0.5 hidden text-[0.625rem] leading-none text-[var(--whiteboard-muted)] md:block"
            >
              {tool.shortcut}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {tool.label} <span aria-hidden="true">· {tool.shortcut}</span>
          </TooltipContent>
        </Tooltip>
      ))}

      <div
        aria-hidden="true"
        className="mx-0.5 hidden h-6 w-px shrink-0 bg-[var(--whiteboard-surface-high)] md:block"
      />

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label="More tools"
                    aria-pressed={Boolean(
                      activeExtraTool ?? activeMobileExtraTool,
                    )}
                    className="order-8 md:order-none"
                    disabled={disabled}
                    onKeyDown={(event) =>
                      moveFocus(event, PRIMARY_TOOLS.length)
                    }
                    ref={(button) => {
                      buttonRefs.current[PRIMARY_TOOLS.length] = button;
                    }}
                    size="whiteboard-tool"
                    tabIndex={activeExtraTool ? 0 : -1}
                    variant={
                      activeExtraTool || activeMobileExtraTool
                        ? "whiteboard-active"
                        : "whiteboard"
                    }
                  />
                }
              />
            }
          >
            <DesktopExtraToolIcon className="hidden md:block" />
            <MobileExtraToolIcon className="md:hidden" />
          </TooltipTrigger>
          <TooltipContent>More tools</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>More tools</DropdownMenuLabel>
            {EXTRA_TOOLS.map((tool) => (
              <DropdownMenuItem
                key={tool.type}
                onClick={() => onSelectTool(tool.type)}
              >
                <tool.icon />
                {tool.label}
                <DropdownMenuShortcut>{tool.shortcut}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuGroup className="md:hidden">
            <DropdownMenuSeparator />
            {MOBILE_EXTRA_TOOLS.filter(
              (tool) => !EXTRA_TOOL_TYPES.has(tool.type),
            ).map((tool) => (
              <DropdownMenuItem
                key={tool.type}
                onClick={() => onSelectTool(tool.type)}
              >
                <tool.icon />
                {tool.label}
                <DropdownMenuShortcut>{tool.shortcut}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PropertiesPanel({
  engine,
  editorState,
  compact = false,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly editorState: OwnedWhiteboardEditorState;
  readonly compact?: boolean;
}) {
  const updateStyle = useCallback(
    (update: Partial<WhiteboardElementStyle>) => {
      engine?.updateElementStyle(update);
    },
    [engine],
  );

  return (
    <section
      aria-label="Element properties"
      className={cn(
        "rounded-lg bg-[var(--whiteboard-island)] p-3 shadow-[var(--whiteboard-shadow)]",
        compact ? "w-full bg-transparent p-4 shadow-none" : "w-[12.625rem]",
      )}
    >
      <FieldGroup className="gap-3">
        <FieldSet className="gap-3" disabled={!engine}>
          <FieldLegend className="sr-only">Element properties</FieldLegend>
          <ColorField
            colors={STROKE_COLORS}
            label="Stroke"
            onChange={(strokeColor) => updateStyle({ strokeColor })}
            theme={editorState.theme}
            value={editorState.elementStyle.strokeColor}
          />
          <ColorField
            colors={FILL_COLORS}
            label="Background"
            onChange={(backgroundColor) => updateStyle({ backgroundColor })}
            theme={editorState.theme}
            value={editorState.elementStyle.backgroundColor}
          />
        </FieldSet>

        <FieldSet className="gap-1.5" disabled={!engine}>
          <FieldLegend className="text-xs font-normal" variant="label">
            Fill
          </FieldLegend>
          <ToggleGroup
            aria-label="Fill style"
            disabled={!engine}
            onValueChange={(values) => {
              const value = values[0] as WhiteboardFillStyle | undefined;
              if (value) updateStyle({ fillStyle: value });
            }}
            size="whiteboard"
            spacing={2}
            value={[editorState.elementStyle.fillStyle]}
            variant="whiteboard"
          >
            <ToggleGroupItem aria-label="Hachure fill" value="hachure">
              <span
                aria-hidden="true"
                className="size-4 rounded-sm border border-[var(--whiteboard-outline)] bg-[repeating-linear-gradient(135deg,transparent_0,transparent_3px,currentColor_3px,currentColor_4px)]"
              />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Cross-hatch fill" value="cross-hatch">
              <span
                aria-hidden="true"
                className="size-4 rounded-sm border border-[var(--whiteboard-outline)] bg-[repeating-linear-gradient(45deg,transparent_0,transparent_3px,currentColor_3px,currentColor_4px),repeating-linear-gradient(135deg,transparent_0,transparent_3px,currentColor_3px,currentColor_4px)]"
              />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Solid fill" value="solid">
              <span
                aria-hidden="true"
                className="size-4 rounded-sm border border-current bg-current"
              />
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <FieldSet className="gap-1.5" disabled={!engine}>
          <FieldLegend className="text-xs font-normal" variant="label">
            Stroke width
          </FieldLegend>
          <ToggleGroup
            aria-label="Stroke width"
            disabled={!engine}
            onValueChange={(values) => {
              const value = Number(values[0]);
              if (Number.isFinite(value) && value > 0) {
                updateStyle({ strokeWidth: value });
              }
            }}
            size="whiteboard"
            spacing={2}
            value={[String(editorState.elementStyle.strokeWidth)]}
            variant="whiteboard"
          >
            <ToggleGroupItem aria-label="Thin stroke" value="1">
              <span
                aria-hidden="true"
                className="h-px w-4 rounded-full bg-current"
              />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Medium stroke" value="2">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 rounded-full bg-current"
              />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Bold stroke" value="4">
              <span
                aria-hidden="true"
                className="h-1 w-4 rounded-full bg-current"
              />
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <FieldSet className="gap-1.5" disabled={!engine}>
          <FieldLegend className="text-xs font-normal" variant="label">
            Stroke style
          </FieldLegend>
          <ToggleGroup
            aria-label="Stroke style"
            disabled={!engine}
            onValueChange={(values) => {
              const value = values[0] as WhiteboardStrokeStyle | undefined;
              if (value) updateStyle({ strokeStyle: value });
            }}
            size="whiteboard"
            spacing={2}
            value={[editorState.elementStyle.strokeStyle]}
            variant="whiteboard"
          >
            <ToggleGroupItem aria-label="Solid stroke" value="solid">
              <span aria-hidden="true" className="h-0.5 w-4 bg-current" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Dashed stroke" value="dashed">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 bg-[repeating-linear-gradient(90deg,currentColor_0,currentColor_4px,transparent_4px,transparent_7px)]"
              />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Dotted stroke" value="dotted">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 bg-[radial-gradient(circle,currentColor_1px,transparent_1.5px)] bg-[length:4px_2px]"
              />
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <FieldSet className="gap-1.5" disabled={!engine}>
          <FieldLegend className="text-xs font-normal" variant="label">
            Sloppiness
          </FieldLegend>
          <ToggleGroup
            aria-label="Sloppiness"
            disabled={!engine}
            onValueChange={(values) => {
              const roughness = Number(values[0]);
              if (Number.isFinite(roughness)) updateStyle({ roughness });
            }}
            size="whiteboard"
            spacing={2}
            value={[String(editorState.elementStyle.roughness ?? 1)]}
            variant="whiteboard"
          >
            {[0, 1, 2].map((roughness) => (
              <ToggleGroupItem
                aria-label={
                  roughness === 0
                    ? "Architect"
                    : roughness === 1
                      ? "Artist"
                      : "Cartoonist"
                }
                key={roughness}
                value={String(roughness)}
              >
                <RoughnessPreview roughness={roughness} />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FieldSet>

        <FieldSet className="gap-1.5" disabled={!engine}>
          <FieldLegend className="text-xs font-normal" variant="label">
            Edges
          </FieldLegend>
          <ToggleGroup
            aria-label="Edges"
            disabled={!engine}
            onValueChange={(values) => {
              const roundness = values[0] as WhiteboardEdgeStyle | undefined;
              if (roundness) updateStyle({ roundness });
            }}
            size="whiteboard"
            spacing={2}
            value={[editorState.elementStyle.roundness ?? "round"]}
            variant="whiteboard"
          >
            <ToggleGroupItem aria-label="Sharp edges" value="sharp">
              <Square />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Round edges" value="round">
              <SquareRoundCorner />
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <Field className="gap-1.5">
          <FieldLabel className="text-xs font-normal">Opacity</FieldLabel>
          <Slider
            disabled={!engine}
            max={100}
            min={0}
            onValueChange={(values: number | readonly number[]) => {
              const opacity = typeof values === "number" ? values : values[0];
              if (opacity !== undefined) updateStyle({ opacity });
            }}
            step={10}
            thumbLabel="Opacity"
            value={[editorState.elementStyle.opacity]}
          />
          <div
            aria-hidden="true"
            className="flex justify-between text-xs text-[var(--whiteboard-muted)]"
          >
            <span>0</span>
            <span>100</span>
          </div>
        </Field>

        {editorState.selectedElementIds.length > 0 && (
          <FieldSet className="gap-1.5" disabled={!engine}>
            <FieldLegend className="text-xs font-normal" variant="label">
              Layers
            </FieldLegend>
            <div className="flex gap-1">
              <TooltipButton
                disabled={!engine?.reorderSelection}
                icon={SendToBack}
                label="Send to back"
                onClick={() => engine?.reorderSelection?.("back")}
                size="whiteboard-icon"
                variant="whiteboard-panel"
              />
              <TooltipButton
                disabled={!engine?.reorderSelection}
                icon={ArrowDown}
                label="Send backward"
                onClick={() => engine?.reorderSelection?.("backward")}
                size="whiteboard-icon"
                variant="whiteboard-panel"
              />
              <TooltipButton
                disabled={!engine?.reorderSelection}
                icon={ArrowUp}
                label="Bring forward"
                onClick={() => engine?.reorderSelection?.("forward")}
                size="whiteboard-icon"
                variant="whiteboard-panel"
              />
              <TooltipButton
                disabled={!engine?.reorderSelection}
                icon={BringToFront}
                label="Bring to front"
                onClick={() => engine?.reorderSelection?.("front")}
                size="whiteboard-icon"
                variant="whiteboard-panel"
              />
            </div>
          </FieldSet>
        )}
      </FieldGroup>
    </section>
  );
}

function ColorField({
  colors,
  label,
  onChange,
  theme,
  value,
}: {
  readonly colors: readonly string[];
  readonly label: string;
  readonly onChange: (color: string) => void;
  readonly theme: WhiteboardTheme;
  readonly value: string;
}) {
  return (
    <Field className="gap-1.5">
      <FieldLabel className="text-xs font-normal">{label}</FieldLabel>
      <div className="flex items-center gap-3">
        <ToggleGroup
          aria-label={label}
          onValueChange={(values) => {
            const color = values[0];
            if (color) onChange(color);
          }}
          size="whiteboard-swatch"
          spacing={1}
          value={[value]}
          variant="whiteboard"
        >
          {colors.map((color) => (
            <ToggleGroupItem
              aria-label={`${label}: ${color}`}
              key={color}
              value={color}
            >
              <span
                className="size-5 rounded-sm border border-black/15"
                style={{
                  background:
                    color === "transparent"
                      ? "linear-gradient(135deg, transparent 46%, #e03131 47%, #e03131 53%, transparent 54%), #fff"
                      : color,
                  filter:
                    theme === "dark" ? OWNED_DARK_THEME_FILTER : undefined,
                }}
              />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Input
          aria-label={`Custom ${label.toLowerCase()}`}
          className="size-6 shrink-0 cursor-pointer rounded-md border-0 p-0.5"
          onChange={(event) => onChange(event.currentTarget.value)}
          type="color"
          value={
            /^#[\da-f]{6}$/i.test(value)
              ? value
              : label === "Background"
                ? "#ffffff"
                : "#1e1e1e"
          }
        />
      </div>
    </Field>
  );
}

function RoughnessPreview({ roughness }: { readonly roughness: number }) {
  const path =
    roughness === 0
      ? "M2 9 L14 9"
      : roughness === 1
        ? "M2 9 C5 7 9 11 14 8"
        : "M2 11 C4 5 8 12 14 6";

  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path d={path} stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function MobileProperties({
  engine,
  editorState,
  open,
  showProperties,
  onRedo,
  onUndo,
  onOpenChange,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly editorState: OwnedWhiteboardEditorState;
  readonly open: boolean;
  readonly showProperties: boolean;
  readonly onRedo: () => void;
  readonly onUndo: () => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const background = editorState.elementStyle.backgroundColor;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <div className="flex items-center justify-between">
        {showProperties ? (
          <div className="flex items-center gap-1">
            <SheetTrigger
              render={
                <Button
                  aria-label="Stroke properties"
                  disabled={!engine}
                  size="whiteboard-icon"
                  variant="whiteboard"
                />
              }
            >
              <span
                aria-hidden="true"
                className="size-6 rounded-md border border-black/15"
                style={{
                  background: `repeating-linear-gradient(135deg, ${editorState.elementStyle.strokeColor} 0, ${editorState.elementStyle.strokeColor} 2px, transparent 2px, transparent 4px)`,
                  filter:
                    editorState.theme === "dark"
                      ? OWNED_DARK_THEME_FILTER
                      : undefined,
                }}
              />
            </SheetTrigger>
            <SheetTrigger
              render={
                <Button
                  aria-label="Background properties"
                  disabled={!engine}
                  size="whiteboard-icon"
                  variant="whiteboard"
                />
              }
            >
              <span
                aria-hidden="true"
                className="size-6 rounded-md border border-black/15"
                style={{
                  background:
                    background === "transparent"
                      ? "linear-gradient(135deg, transparent 46%, #e03131 47%, #e03131 53%, transparent 54%), #fff"
                      : background,
                  filter:
                    editorState.theme === "dark"
                      ? OWNED_DARK_THEME_FILTER
                      : undefined,
                }}
              />
            </SheetTrigger>
            <SheetTrigger
              render={
                <Button
                  aria-label="Element properties"
                  disabled={!engine}
                  size="whiteboard-icon"
                  variant="whiteboard"
                />
              }
            >
              <Settings2 />
            </SheetTrigger>
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          <Button
            aria-label="Undo"
            disabled={!engine}
            onClick={onUndo}
            size="whiteboard-icon"
            variant="whiteboard"
          >
            <Undo2 />
          </Button>
          <Button
            aria-label="Redo"
            disabled={!engine}
            onClick={onRedo}
            size="whiteboard-icon"
            variant="whiteboard"
          >
            <Redo2 />
          </Button>
        </div>
      </div>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Element properties</SheetTitle>
          <SheetDescription>
            Change the selected element or next drawing style.
          </SheetDescription>
        </SheetHeader>
        <PropertiesPanel compact engine={engine} editorState={editorState} />
      </SheetContent>
    </Sheet>
  );
}

type ViewportControlsProps = {
  readonly disabled: boolean;
  readonly zoom: number;
  readonly onRedo: () => void;
  readonly onReset: () => void;
  readonly onUndo: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
};

function ViewportControls({
  disabled,
  zoom,
  onRedo,
  onReset,
  onUndo,
  onZoomIn,
  onZoomOut,
}: ViewportControlsProps) {
  return (
    <div
      aria-label="Viewport controls"
      className="pointer-events-auto absolute bottom-4 left-4 hidden items-center gap-2 md:flex"
      role="group"
    >
      <div className="flex overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--whiteboard-surface-lowest)]">
        <TooltipButton
          disabled={disabled || zoom <= MIN_ZOOM}
          icon={Minus}
          label="Zoom out"
          onClick={onZoomOut}
          size="whiteboard-tool"
          variant="whiteboard-group-control"
        />
        <Button
          aria-label="Reset zoom"
          className="w-[3.75rem] tabular-nums"
          disabled={disabled}
          onClick={onReset}
          size="whiteboard-tool"
          variant="whiteboard-group-control"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <TooltipButton
          disabled={disabled || zoom >= MAX_ZOOM}
          icon={Plus}
          label="Zoom in"
          onClick={onZoomIn}
          size="whiteboard-tool"
          variant="whiteboard-group-control"
        />
      </div>
      <div className="flex overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--whiteboard-surface-lowest)]">
        <TooltipButton
          disabled={disabled}
          icon={Undo2}
          label="Undo"
          onClick={onUndo}
          size="whiteboard-tool"
          variant="whiteboard-group-control"
        />
        <TooltipButton
          disabled={disabled}
          icon={Redo2}
          label="Redo"
          onClick={onRedo}
          size="whiteboard-tool"
          variant="whiteboard-group-control"
        />
      </div>
    </div>
  );
}

function CanvasContextMenu({
  disabled,
  onClear,
  onFit,
  onRedo,
  onUndo,
}: {
  readonly disabled: boolean;
  readonly onClear: () => void;
  readonly onFit: () => void;
  readonly onRedo: () => void;
  readonly onUndo: () => void;
}) {
  return (
    <ContextMenuContent className="w-48">
      <ContextMenuGroup>
        <ContextMenuLabel>Canvas</ContextMenuLabel>
        <ContextMenuItem disabled={disabled} onClick={onUndo}>
          <Undo2 />
          Undo
          <ContextMenuShortcut>⌘Z</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={onRedo}>
          <Redo2 />
          Redo
          <ContextMenuShortcut>⇧⌘Z</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem disabled={disabled} onClick={onFit}>
          <Scan />
          Fit to content
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={onClear}>
          Clear canvas
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  );
}

function ImportDialog({
  engine,
  open,
  onImported,
  onOpenChange,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly open: boolean;
  readonly onImported?: (name: string | null) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) setFile(null);
  }, [open]);

  async function importFile(): Promise<void> {
    if (!engine || !file || importing) return;
    if (file.size > SCENE_FILE_IMPORT_MAX_BYTES) {
      toast.error("Could not import this scene because the file is too large");
      return;
    }
    setImporting(true);
    try {
      const result = await engine.importDocument(file);
      onImported?.(result.name);
      onOpenChange(false);
      toast.success("Scene imported");
    } catch (error) {
      console.error(error);
      toast.error("Could not import this scene");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import scene</DialogTitle>
          <DialogDescription>
            Choose a Drawstuff scene file to replace the current canvas.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="whiteboard-import-file">Scene file</FieldLabel>
            <Input
              accept=".drawstuff,application/json"
              disabled={importing}
              id="whiteboard-import-file"
              onChange={(event) =>
                setFile(event.currentTarget.files?.[0] ?? null)
              }
              type="file"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            disabled={importing}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!engine || !file || importing}
            onClick={() => void importFile()}
          >
            <FileUp data-icon="inline-start" />
            {importing ? "Importing" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClearCanvasDialog({
  open,
  onConfirm,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear the canvas?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes every element from the current scene. You can undo the
            change after clearing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Clear canvas
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ExportFormat = "drawstuff" | "png" | "svg";

function ExportDialog({
  engine,
  hasSelection,
  sceneName,
  open,
  onOpenChange,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly hasSelection: boolean;
  readonly sceneName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("drawstuff");
  const [exporting, setExporting] = useState(false);
  const [scale, setScale] = useState(1);
  const [background, setBackground] = useState(true);
  const [selectionOnly, setSelectionOnly] = useState(false);

  async function exportScene(): Promise<void> {
    if (!engine || exporting) return;
    setExporting(true);
    try {
      const blob =
        format === "drawstuff"
          ? await engine.exportDocument()
          : await engine.exportImage({
              format,
              scale,
              background,
              selectionOnly: selectionOnly && hasSelection,
            });
      triggerBlobDownload(
        `${safeFileName(sceneName || "Untitled")}.${format}`,
        blob,
      );
      onOpenChange(false);
      toast.success("Export ready");
    } catch (error) {
      console.error(error);
      toast.error("Could not export this scene");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export scene</DialogTitle>
          <DialogDescription>
            Download an editable scene or a rendered image.
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend variant="label">Format</FieldLegend>
          <ToggleGroup
            aria-label="Export format"
            disabled={exporting}
            onValueChange={(values) => {
              const next = values[0] as ExportFormat | undefined;
              if (next) setFormat(next);
            }}
            spacing={0}
            value={[format]}
            variant="outline"
          >
            <ToggleGroupItem value="drawstuff">Document</ToggleGroupItem>
            <ToggleGroupItem value="png">PNG</ToggleGroupItem>
            <ToggleGroupItem value="svg">SVG</ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>
        <FieldSet disabled={format === "drawstuff" || exporting}>
          <FieldLegend variant="label">Image scale</FieldLegend>
          <ToggleGroup
            aria-label="Image scale"
            disabled={format === "drawstuff" || exporting}
            onValueChange={(values) => {
              const next = Number(values[0]);
              if (Number.isFinite(next) && next > 0) setScale(next);
            }}
            spacing={0}
            value={[String(scale)]}
            variant="outline"
          >
            <ToggleGroupItem value="1">1×</ToggleGroupItem>
            <ToggleGroupItem value="2">2×</ToggleGroupItem>
            <ToggleGroupItem value="3">3×</ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>
        <FieldSet disabled={format === "drawstuff" || exporting}>
          <FieldLegend variant="label">Image contents</FieldLegend>
          <ToggleGroup
            aria-label="Image contents"
            disabled={format === "drawstuff" || exporting}
            onValueChange={(values) => {
              setBackground(values.includes("background"));
              setSelectionOnly(values.includes("selection"));
            }}
            value={[
              ...(background ? ["background"] : []),
              ...(selectionOnly ? ["selection"] : []),
            ]}
            variant="outline"
          >
            <ToggleGroupItem value="background">Background</ToggleGroupItem>
            <ToggleGroupItem disabled={!hasSelection} value="selection">
              Selection only
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>
        <DialogFooter>
          <Button
            disabled={exporting}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!engine || exporting}
            onClick={() => void exportScene()}
          >
            <Download data-icon="inline-start" />
            {exporting ? "Exporting" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Work faster without leaving the canvas.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2">
          {TOOLS.filter((tool) => tool.type !== "image").map((tool) => (
            <ShortcutRow
              key={tool.type}
              label={tool.label}
              shortcut={tool.shortcut}
            />
          ))}
          <ShortcutRow label="Zoom in" shortcut="+" />
          <ShortcutRow label="Zoom out" shortcut="−" />
          <ShortcutRow label="Reset zoom" shortcut="0" />
          <ShortcutRow label="Close dialog or menu" shortcut="Esc" />
        </dl>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutRow({
  label,
  shortcut,
}: {
  readonly label: string;
  readonly shortcut: string;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono text-xs">
          {shortcut}
        </kbd>
      </dd>
    </>
  );
}

function TooltipButton({
  className,
  disabled,
  icon: IconComponent,
  label,
  onClick,
  size = "icon",
  variant = "ghost",
}: {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly icon: Icon;
  readonly label: string;
  readonly onClick: () => void;
  readonly size?: React.ComponentProps<typeof Button>["size"];
  readonly variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={className}
            disabled={disabled}
            onClick={onClick}
            size={size}
            variant={variant}
          />
        }
      >
        <IconComponent />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function safeFileName(name: string): string {
  const sanitized = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  return sanitized || "Untitled";
}
