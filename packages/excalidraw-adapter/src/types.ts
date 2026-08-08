import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";

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
  | "onChange"
  | "onPointerUpdate"
  | "renderCustomStats"
  | "renderTopRightUI"
  | "theme"
  | "UIOptions"
  | "validateEmbeddable"
  // Viewer-role collaboration renders the editor read-only.
  | "viewModeEnabled"
>;

export type ExcalidrawValidateEmbeddable =
  ExcalidrawProps["validateEmbeddable"];

export type ExcalidrawPointerUpdatePayload = Parameters<
  NonNullable<ExcalidrawProps["onPointerUpdate"]>
>[0];
