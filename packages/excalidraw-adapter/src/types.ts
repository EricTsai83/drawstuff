import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";

export type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
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
  | "langCode"
  | "onChange"
  | "renderCustomStats"
  | "renderTopRightUI"
  | "theme"
  | "UIOptions"
  | "validateEmbeddable"
  | "viewModeEnabled"
>;

export type ExcalidrawValidateEmbeddable =
  ExcalidrawProps["validateEmbeddable"];
