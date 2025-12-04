import { ValidACLs, ValidContentDispositions } from "@uploadthing/shared";
import * as S from "effect/Schema";

//#region src/_internal/shared-schemas.ts
const ContentDispositionSchema = S.Literal(...ValidContentDispositions);
const ACLSchema = S.Literal(...ValidACLs);
/**
* Valid options for the `?actionType` query param
*/
const ActionType = S.Literal("upload");
/**
* Valid options for the `uploadthing-hook` header
* for requests coming from UT server
*/
const UploadThingHook = S.Literal("callback", "error");
/**
* =============================================================================
* =========================== Configuration ===================================
* =============================================================================
*/
const DecodeString = S.transform(S.Uint8ArrayFromSelf, S.String, {
	decode: (data) => new TextDecoder().decode(data),
	encode: (data) => new TextEncoder().encode(data)
});
const ParsedToken = S.Struct({
	apiKey: S.Redacted(S.String.pipe(S.startsWith("sk_"))),
	appId: S.String,
	regions: S.NonEmptyArray(S.String),
	ingestHost: S.String.pipe(S.optionalWith({ default: () => "ingest.uploadthing.com" }))
});
const UploadThingToken = S.Uint8ArrayFromBase64.pipe(S.compose(DecodeString), S.compose(S.parseJson(ParsedToken)));
/**
* =============================================================================
* ======================== File Type Hierarchy ===============================
* =============================================================================
*/
/**
* Properties from the web File object, this is what the client sends when initiating an upload
*/
var FileUploadData = class extends S.Class("FileUploadData")({
	name: S.String,
	size: S.Number,
	type: S.String,
	lastModified: S.Number.pipe(S.optional)
}) {};
/**
* `.middleware()` can add a customId to the incoming file data
*/
var FileUploadDataWithCustomId = class extends FileUploadData.extend("FileUploadDataWithCustomId")({ customId: S.NullOr(S.String) }) {};
/**
* When files are uploaded, we get back
* - a key
* - URLs for the file
* - the hash (md5-hex) of the uploaded file's contents
*/
var UploadedFileData = class extends FileUploadDataWithCustomId.extend("UploadedFileData")({
	key: S.String,
	url: S.String,
	appUrl: S.String,
	ufsUrl: S.String,
	fileHash: S.String
}) {};
var MetadataFetchStreamPart = class extends S.Class("MetadataFetchStreamPart")({
	payload: S.String,
	signature: S.String,
	hook: UploadThingHook
}) {};
var MetadataFetchResponse = class extends S.Class("MetadataFetchResponse")({ ok: S.Boolean }) {};
var CallbackResultResponse = class extends S.Class("CallbackResultResponse")({ ok: S.Boolean }) {};
/**
* =============================================================================
* ======================== Client Action Payloads ============================
* =============================================================================
*/
var UploadActionPayload = class extends S.Class("UploadActionPayload")({
	files: S.Array(FileUploadData),
	input: S.Unknown
}) {};

//#endregion
export { ActionType, CallbackResultResponse, MetadataFetchResponse, MetadataFetchStreamPart, UploadActionPayload, UploadThingHook, UploadThingToken, UploadedFileData };
//# sourceMappingURL=shared-schemas-BmG5ARoX.js.map