"use client";

import {
  ArrowRight,
  Circle,
  Diamond,
  Download,
  Eraser,
  FilePenLine,
  FileUp,
  Frame,
  Hand,
  HelpCircle,
  Image,
  Menu,
  Minus,
  MousePointer2,
  Palette,
  Pencil,
  Plus,
  Redo2,
  Save,
  Scan,
  Settings2,
  Share2,
  Slash,
  Square,
  Sparkles,
  Type,
  Undo2,
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
  FieldDescription,
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
import type {
  WhiteboardEditorState,
  WhiteboardElementStyle,
  WhiteboardEngine,
  WhiteboardFillStyle,
  WhiteboardStrokeStyle,
} from "@/features/whiteboard";
import { triggerBlobDownload } from "@/lib/download";
import { cn } from "@/lib/utils";

type Icon = ComponentType<React.ComponentProps<"svg">>;

type ToolDefinition = {
  readonly type: string;
  readonly label: string;
  readonly shortcut: string;
  readonly icon: Icon;
};

const TOOLS: readonly ToolDefinition[] = [
  { type: "selection", label: "Select", shortcut: "1", icon: MousePointer2 },
  { type: "hand", label: "Hand", shortcut: "H", icon: Hand },
  { type: "rectangle", label: "Rectangle", shortcut: "2", icon: Square },
  { type: "diamond", label: "Diamond", shortcut: "3", icon: Diamond },
  { type: "ellipse", label: "Ellipse", shortcut: "4", icon: Circle },
  { type: "arrow", label: "Arrow", shortcut: "5", icon: ArrowRight },
  { type: "line", label: "Line", shortcut: "6", icon: Slash },
  { type: "freedraw", label: "Draw", shortcut: "7", icon: Pencil },
  { type: "text", label: "Text", shortcut: "8", icon: Type },
  { type: "image", label: "Image", shortcut: "9", icon: Image },
  { type: "eraser", label: "Eraser", shortcut: "E", icon: Eraser },
  { type: "frame", label: "Frame", shortcut: "F", icon: Frame },
  { type: "laser", label: "Laser", shortcut: "K", icon: Sparkles },
] as const;

const TOOL_SHORTCUTS = new Map(
  TOOLS.map((tool) => [tool.shortcut.toLowerCase(), tool.type]),
);

const STROKE_COLORS = [
  "#1e1e1e",
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#6741d9",
] as const;
const FILL_COLORS = [
  "transparent",
  "#ffc9c9",
  "#b2f2bb",
  "#a5d8ff",
  "#d0bfff",
] as const;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

const DISCONNECTED_STATE: WhiteboardEditorState = {
  activeTool: { type: "selection", locked: false, customType: null },
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
  elementStyle: {
    strokeColor: STROKE_COLORS[0],
    backgroundColor: FILL_COLORS[0],
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
  },
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

  const selectTool = useCallback(
    (type: string) => {
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
        key === "-" ||
        key === "0";
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
        engine.setActiveTool({ type: nextTool });
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
      if (key === "0") {
        event.preventDefault();
        event.stopPropagation();
        resetZoom();
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
    zoomBy,
  ]);

  const clearCanvas = useCallback(() => {
    engine?.clearDocument();
    setClearOpen(false);
  }, [engine]);

  return (
    <TooltipProvider>
      <ContextMenu>
        <ContextMenuTrigger
          className="owned-whiteboard-shell relative isolate h-full w-full"
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
              activeTool={editorState.activeTool.type}
              disabled={!engine}
              onSelectTool={selectTool}
            />

            <div className="pointer-events-auto absolute top-16 left-3 hidden lg:block">
              <PropertiesPanel engine={engine} editorState={editorState} />
            </div>

            <div className="pointer-events-auto absolute right-3 bottom-20 lg:hidden">
              <MobileProperties
                engine={engine}
                editorState={editorState}
                open={propertiesOpen}
                onOpenChange={setPropertiesOpen}
              />
            </div>

            <ViewportControls
              disabled={!engine}
              zoom={editorState.viewport.zoom}
              onFit={fitToContent}
              onReset={resetZoom}
              onZoomIn={() => zoomBy(ZOOM_STEP)}
              onZoomOut={() => zoomBy(-ZOOM_STEP)}
            />
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
    </TooltipProvider>
  );
}

function useWhiteboardEditorState(
  engine: WhiteboardEngine | null,
): WhiteboardEditorState {
  const [state, setState] = useState<WhiteboardEditorState>(DISCONNECTED_STATE);

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
    <header className="pointer-events-auto absolute inset-x-3 top-3 flex items-center justify-between gap-3">
      <div className="bg-background/90 flex min-w-0 items-center gap-1 rounded-xl border p-1 shadow-sm backdrop-blur">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label="Main menu"
                      size="icon"
                      variant="ghost"
                    />
                  }
                />
              }
            >
              <Menu />
            </TooltipTrigger>
            <TooltipContent>Main menu</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Scene</DropdownMenuLabel>
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

        <Button
          className="max-w-44 justify-start truncate sm:max-w-64"
          disabled={!connected}
          onClick={onRename}
          variant="ghost"
        >
          <FilePenLine data-icon="inline-start" />
          <span className="truncate">{sceneName || "Untitled"}</span>
        </Button>
      </div>

      <div className="bg-background/90 flex items-center gap-1 rounded-xl border p-1 shadow-sm backdrop-blur">
        <TooltipButton
          disabled={!connected || isSaving}
          icon={Save}
          label={isSaving ? "Saving" : "Save"}
          onClick={onSave}
        />
        <Button disabled={!connected || isSharing} onClick={onShare} size="sm">
          <Share2 data-icon="inline-start" />
          <span className="hidden sm:inline">
            {isSharing ? "Sharing" : "Share"}
          </span>
        </Button>
      </div>
    </header>
  );
}

type DrawingToolbarProps = {
  readonly activeTool: string;
  readonly disabled: boolean;
  readonly onSelectTool: (type: string) => void;
};

function DrawingToolbar({
  activeTool,
  disabled,
  onSelectTool,
}: DrawingToolbarProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabStopTool = TOOLS.some((tool) => tool.type === activeTool)
    ? activeTool
    : "selection";

  function moveFocus(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    const lastIndex = TOOLS.length - 1;
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
      className="bg-background/90 pointer-events-auto absolute inset-x-3 bottom-3 flex items-center gap-1 overflow-x-auto rounded-xl border p-1 shadow-sm backdrop-blur md:inset-x-auto md:top-16 md:bottom-auto md:left-1/2 md:-translate-x-1/2"
      role="toolbar"
    >
      {TOOLS.map((tool, index) => (
        <Tooltip key={tool.type}>
          <TooltipTrigger
            render={
              <Button
                aria-label={tool.label}
                aria-pressed={activeTool === tool.type}
                disabled={disabled}
                onKeyDown={(event) => moveFocus(event, index)}
                onClick={() => onSelectTool(tool.type)}
                ref={(button) => {
                  buttonRefs.current[index] = button;
                }}
                size="icon"
                tabIndex={tabStopTool === tool.type ? 0 : -1}
                variant={activeTool === tool.type ? "secondary" : "ghost"}
              />
            }
          >
            <tool.icon />
          </TooltipTrigger>
          <TooltipContent>
            {tool.label} <span aria-hidden="true">· {tool.shortcut}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function PropertiesPanel({
  engine,
  editorState,
  compact = false,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly editorState: WhiteboardEditorState;
  readonly compact?: boolean;
}) {
  const canStyle =
    Boolean(engine) &&
    (editorState.selectedElementIds.length > 0 ||
      !["selection", "hand", "eraser", "frame", "laser"].includes(
        editorState.activeTool.type,
      ));
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
        "bg-background/90 rounded-xl border p-3 shadow-sm backdrop-blur",
        compact ? "w-full border-0 bg-transparent p-4 shadow-none" : "w-60",
      )}
    >
      <FieldGroup>
        <FieldSet disabled={!canStyle}>
          <FieldLegend>Element properties</FieldLegend>
          <ColorField
            colors={STROKE_COLORS}
            label="Stroke color"
            onChange={(strokeColor) => updateStyle({ strokeColor })}
            value={editorState.elementStyle.strokeColor}
          />
          <ColorField
            colors={FILL_COLORS}
            label="Fill color"
            onChange={(backgroundColor) => updateStyle({ backgroundColor })}
            value={editorState.elementStyle.backgroundColor}
          />
        </FieldSet>

        <FieldSet disabled={!canStyle}>
          <FieldLegend variant="label">Fill</FieldLegend>
          <ToggleGroup
            aria-label="Fill style"
            disabled={!canStyle}
            onValueChange={(values) => {
              const value = values[0] as WhiteboardFillStyle | undefined;
              if (value) updateStyle({ fillStyle: value });
            }}
            spacing={0}
            value={[editorState.elementStyle.fillStyle]}
            variant="outline"
          >
            <ToggleGroupItem aria-label="Hachure fill" value="hachure">
              Hachure
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Solid fill" value="solid">
              Solid
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <FieldSet disabled={!canStyle}>
          <FieldLegend variant="label">Stroke width</FieldLegend>
          <ToggleGroup
            aria-label="Stroke width"
            disabled={!canStyle}
            onValueChange={(values) => {
              const value = Number(values[0]);
              if (Number.isFinite(value) && value > 0) {
                updateStyle({ strokeWidth: value });
              }
            }}
            spacing={0}
            value={[String(editorState.elementStyle.strokeWidth)]}
            variant="outline"
          >
            <ToggleGroupItem aria-label="Thin stroke" value="1">
              Thin
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Medium stroke" value="2">
              Medium
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Bold stroke" value="4">
              Bold
            </ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <FieldSet disabled={!canStyle}>
          <FieldLegend variant="label">Stroke style</FieldLegend>
          <ToggleGroup
            aria-label="Stroke style"
            disabled={!canStyle}
            onValueChange={(values) => {
              const value = values[0] as WhiteboardStrokeStyle | undefined;
              if (value) updateStyle({ strokeStyle: value });
            }}
            spacing={0}
            value={[editorState.elementStyle.strokeStyle]}
            variant="outline"
          >
            <ToggleGroupItem value="solid">Solid</ToggleGroupItem>
            <ToggleGroupItem value="dashed">Dashed</ToggleGroupItem>
            <ToggleGroupItem value="dotted">Dotted</ToggleGroupItem>
          </ToggleGroup>
        </FieldSet>

        <Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel>Opacity</FieldLabel>
            <span className="text-muted-foreground text-xs tabular-nums">
              {editorState.elementStyle.opacity}%
            </span>
          </div>
          <Slider
            disabled={!canStyle}
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
        </Field>
        {!canStyle && (
          <FieldDescription>
            Select an element or choose a drawing tool to edit its appearance.
          </FieldDescription>
        )}
      </FieldGroup>
    </section>
  );
}

function ColorField({
  colors,
  label,
  onChange,
  value,
}: {
  readonly colors: readonly string[];
  readonly label: string;
  readonly onChange: (color: string) => void;
  readonly value: string;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {colors.map((color) => (
          <Button
            aria-label={`${label}: ${color}`}
            aria-pressed={value === color}
            key={color}
            onClick={() => onChange(color)}
            size="icon-sm"
            type="button"
            variant={value === color ? "secondary" : "outline"}
          >
            <span
              className="size-4 rounded-full border"
              style={{ backgroundColor: color }}
            />
          </Button>
        ))}
      </div>
    </Field>
  );
}

function MobileProperties({
  engine,
  editorState,
  open,
  onOpenChange,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly editorState: WhiteboardEditorState;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SheetTrigger
              render={
                <Button
                  aria-label="Element properties"
                  disabled={!engine}
                  size="icon"
                  variant="outline"
                />
              }
            />
          }
        >
          <Palette />
        </TooltipTrigger>
        <TooltipContent>Element properties</TooltipContent>
      </Tooltip>
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
  readonly onFit: () => void;
  readonly onReset: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
};

function ViewportControls({
  disabled,
  zoom,
  onFit,
  onReset,
  onZoomIn,
  onZoomOut,
}: ViewportControlsProps) {
  return (
    <div
      aria-label="Viewport controls"
      className="bg-background/90 pointer-events-auto absolute bottom-20 left-3 flex items-center gap-1 rounded-xl border p-1 shadow-sm backdrop-blur md:bottom-3"
      role="group"
    >
      <TooltipButton
        disabled={disabled || zoom <= MIN_ZOOM}
        icon={Minus}
        label="Zoom out"
        onClick={onZoomOut}
      />
      <Button
        aria-label="Reset zoom"
        className="min-w-14 tabular-nums"
        disabled={disabled}
        onClick={onReset}
        size="sm"
        variant="ghost"
      >
        {Math.round(zoom * 100)}%
      </Button>
      <TooltipButton
        disabled={disabled || zoom >= MAX_ZOOM}
        icon={Plus}
        label="Zoom in"
        onClick={onZoomIn}
      />
      <TooltipButton
        disabled={disabled}
        icon={Scan}
        label="Fit to content"
        onClick={onFit}
      />
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
            Choose an Excalidraw scene file to replace the current canvas.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="whiteboard-import-file">Scene file</FieldLabel>
            <Input
              accept=".excalidraw,application/json,application/vnd.excalidraw+json"
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

type ExportFormat = "excalidraw" | "png" | "svg";

function ExportDialog({
  engine,
  sceneName,
  open,
  onOpenChange,
}: {
  readonly engine: WhiteboardEngine | null;
  readonly sceneName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("excalidraw");
  const [exporting, setExporting] = useState(false);

  async function exportScene(): Promise<void> {
    if (!engine || exporting) return;
    setExporting(true);
    try {
      const blob =
        format === "excalidraw"
          ? await engine.exportDocument()
          : await engine.exportImage({ format });
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
            <ToggleGroupItem value="excalidraw">Excalidraw</ToggleGroupItem>
            <ToggleGroupItem value="png">PNG</ToggleGroupItem>
            <ToggleGroupItem value="svg">SVG</ToggleGroupItem>
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
  disabled,
  icon: IconComponent,
  label,
  onClick,
}: {
  readonly disabled?: boolean;
  readonly icon: Icon;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            size="icon"
            variant="ghost"
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
