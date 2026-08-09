import type {
  ExcalidrawProps,
  LibraryItem,
  LibraryItems,
  LibraryItemsSource,
} from "@excalidraw/excalidraw/types";
import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";

export type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  Collaborator,
  CollaboratorPointer,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  SceneData,
  SocketId,
  UIAppState,
  LibraryItem,
  LibraryItems,
  LibraryItemsSource,
} from "@excalidraw/excalidraw/types";
export type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
export type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  FileId,
  InitializedExcalidrawImageElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";

export type ExcalidrawCanvasProps = Pick<
  ExcalidrawProps,
  | "children"
  | "excalidrawAPI"
  | "initialData"
  | "isCollaborating"
  | "langCode"
  | "libraryReturnUrl"
  | "onChange"
  | "onLibraryChange"
  | "onPointerUpdate"
  | "renderCustomStats"
  | "renderTopRightUI"
  | "theme"
  | "UIOptions"
  | "validateEmbeddable"
  // Viewer-role collaboration renders the editor read-only.
  | "viewModeEnabled"
>;

export type ExcalidrawLibraryItem = LibraryItem;
export type ExcalidrawLibraryItems = LibraryItems;
export type ExcalidrawLibraryItemsSource = LibraryItemsSource;
export type ExcalidrawLibraryPersistenceAdapter = LibraryPersistenceAdapter;

export type ExcalidrawValidateEmbeddable =
  ExcalidrawProps["validateEmbeddable"];

export type ExcalidrawPointerUpdatePayload = Parameters<
  NonNullable<ExcalidrawProps["onPointerUpdate"]>
>[0];
