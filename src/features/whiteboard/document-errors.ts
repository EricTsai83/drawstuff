export type WhiteboardDocumentErrorCode =
  | "INVALID_JSON"
  | "MALFORMED_DOCUMENT"
  | "MISSING_ASSET"
  | "UNSUPPORTED_ELEMENT"
  | "UNSUPPORTED_FIELD"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_VERSION";

export class WhiteboardDocumentError extends Error {
  public constructor(
    public readonly code: WhiteboardDocumentErrorCode,
    message: string,
    public readonly path = "$",
  ) {
    super(`${message} at ${path}`);
    this.name = "WhiteboardDocumentError";
  }
}
