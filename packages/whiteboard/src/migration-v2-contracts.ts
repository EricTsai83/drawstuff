import type {
  WhiteboardRuntimeAssetV3,
  WhiteboardEdgeStyle,
  WhiteboardElementType,
  WhiteboardFillStyle,
  WhiteboardStrokeStyle,
  WhiteboardTheme,
} from "./contracts";

export type WhiteboardAssetMimeTypeV2 =
  | "application/octet-stream"
  | "image/avif"
  | "image/bmp"
  | "image/gif"
  | "image/jpeg"
  | "image/jfif"
  | "image/png"
  | "image/svg+xml"
  | "image/vnd.microsoft.icon"
  | "image/webp"
  | "image/x-icon";

interface WhiteboardAssetV2Base {
  readonly id: string;
  readonly mimeType: WhiteboardAssetMimeTypeV2;
  readonly created: number;
  readonly lastRetrieved?: number;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface WhiteboardInlineAssetV2 extends WhiteboardAssetV2Base {
  readonly storage: "inline";
  readonly dataURL: string;
}

export interface WhiteboardExternalAssetV2 extends WhiteboardAssetV2Base {
  readonly storage: "external";
}

export type WhiteboardAssetV2 =
  WhiteboardInlineAssetV2 | WhiteboardExternalAssetV2;

interface WhiteboardElementV2Base {
  readonly id: string;
  readonly isDeleted: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: WhiteboardFillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: WhiteboardStrokeStyle;
  readonly opacity: number;
  readonly roughness: number;
  readonly roundness?: WhiteboardEdgeStyle;
  readonly locked: boolean;
}

export interface WhiteboardBoxElementV2 extends WhiteboardElementV2Base {
  readonly type:
    | "diamond"
    | "ellipse"
    | "embeddable"
    | "frame"
    | "iframe"
    | "magicframe"
    | "rectangle";
}

export interface WhiteboardLinearElementV2 extends WhiteboardElementV2Base {
  readonly type: "arrow" | "freedraw" | "line";
  readonly points: readonly (readonly [number, number])[];
}

export interface WhiteboardImageElementV2 extends WhiteboardElementV2Base {
  readonly type: "image";
  readonly fileId: string | null;
}

export interface WhiteboardTextElementV2 extends WhiteboardElementV2Base {
  readonly type: "text";
  readonly text: string;
  readonly originalText: string;
  readonly fontSize: number;
  readonly lineHeight: number;
}

export type WhiteboardElementV2 =
  | WhiteboardBoxElementV2
  | WhiteboardImageElementV2
  | WhiteboardLinearElementV2
  | WhiteboardTextElementV2;

export interface WhiteboardDocumentMetadataV2 {
  readonly name: string;
  readonly theme: WhiteboardTheme;
  readonly viewBackgroundColor: string;
  readonly gridSize: number | null;
}

export interface WhiteboardDocumentV2 {
  readonly version: 2;
  readonly elements: readonly WhiteboardElementV2[];
  readonly assets: Readonly<Record<string, WhiteboardAssetV2>>;
  readonly metadata: WhiteboardDocumentMetadataV2;
}

export interface WhiteboardRuntimeDocumentV2 {
  readonly elements: readonly WhiteboardElementV2[];
  readonly state: {
    readonly name?: string | null;
    readonly theme?: WhiteboardTheme;
    readonly viewBackgroundColor?: string;
    readonly gridSize?: number | null;
  };
  readonly assets: Readonly<Record<string, WhiteboardRuntimeAssetV3>>;
}

export type { WhiteboardElementType };
