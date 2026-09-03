import type {
  ExcalidrawImperativeAPI as UpstreamImperativeAPI,
  ExcalidrawProps,
  LibraryItems,
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
  ExcalidrawInitialDataState,
  OnUserFollowedPayload,
  SceneData,
  SocketId,
  UserToFollow,
  UIAppState,
  LibraryItem,
  LibraryItems,
  LibraryItemsSource,
} from "@excalidraw/excalidraw/types";
export type { ImportedDataState } from "@excalidraw/excalidraw/data/types";

/**
 * Upstream builds this type from `App`'s members, and `resetScene` is a
 * *private* class field, so the published declaration drops its type and the
 * method arrives as `any`. The signature below is the one App.tsx implements
 * (`withBatchedUpdates((opts?: { resetLoadingState: boolean }) => void)`);
 * pinning it here keeps `any` out of every host call site.
 */
export type ExcalidrawImperativeAPI = Omit<
  UpstreamImperativeAPI,
  "resetScene"
> & {
  resetScene: (opts?: { resetLoadingState?: boolean }) => void;
};
export type { SceneBounds } from "@excalidraw/excalidraw/element/bounds";
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
  // Follow mode: the engine owns the follow UI (avatar click, purple frame);
  // the host relays its viewport over its own transport. Follow *events* are
  // consumed through the imperative API instead — upstream declares an
  // `onUserFollow` prop but never invokes it at runtime.
  | "onScrollChange"
  | "renderCustomStats"
  | "renderTopRightUI"
  | "theme"
  | "UIOptions"
  | "validateEmbeddable"
  // Viewer-role collaboration renders the editor read-only.
  | "viewModeEnabled"
>;

export type ExcalidrawLibraryItems = LibraryItems;
export type ExcalidrawLibraryPersistenceAdapter = LibraryPersistenceAdapter;

export type ExcalidrawValidateEmbeddable =
  ExcalidrawProps["validateEmbeddable"];

export type ExcalidrawPointerUpdatePayload = Parameters<
  NonNullable<ExcalidrawProps["onPointerUpdate"]>
>[0];
