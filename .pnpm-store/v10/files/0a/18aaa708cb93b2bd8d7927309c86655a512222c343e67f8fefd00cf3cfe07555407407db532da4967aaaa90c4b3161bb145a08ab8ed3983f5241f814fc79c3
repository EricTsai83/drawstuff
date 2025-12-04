const require_chunk = require('../dist/chunk-CUT6urMc.cjs');
const require_package = require('../dist/package-CKF1Vr61.cjs');
const require_deprecations = require('../dist/deprecations-DPGpmqha.cjs');
require('../dist/shared-schemas-CG9VaBtT.cjs');
const require_upload_builder = require('../dist/upload-builder-RrqQb3by.cjs');
const effect_Array = require_chunk.__toESM(require("effect/Array"));
const __uploadthing_shared = require_chunk.__toESM(require("@uploadthing/shared"));
const effect_Function = require_chunk.__toESM(require("effect/Function"));
const effect_Predicate = require_chunk.__toESM(require("effect/Predicate"));
const effect_Effect = require_chunk.__toESM(require("effect/Effect"));
const __effect_platform_HttpClient = require_chunk.__toESM(require("@effect/platform/HttpClient"));
const __effect_platform_HttpClientRequest = require_chunk.__toESM(require("@effect/platform/HttpClientRequest"));
const __effect_platform_HttpClientResponse = require_chunk.__toESM(require("@effect/platform/HttpClientResponse"));
const effect_Redacted = require_chunk.__toESM(require("effect/Redacted"));
const effect_Schema = require_chunk.__toESM(require("effect/Schema"));
const effect_Cause = require_chunk.__toESM(require("effect/Cause"));
const __uploadthing_mime_types = require_chunk.__toESM(require("@uploadthing/mime-types"));

//#region src/sdk/ut-file.ts
/**
* Extension of the Blob class that simplifies setting the `name` and `customId` properties,
* similar to the built-in File class from Node > 20.
*/
var UTFile = class extends Blob {
	name;
	lastModified;
	customId;
	constructor(parts, name, options) {
		const optionsWithDefaults = {
			...options,
			type: options?.type ?? ((0, __uploadthing_mime_types.lookup)(name) || "application/octet-stream"),
			lastModified: options?.lastModified ?? Date.now()
		};
		super(parts, optionsWithDefaults);
		this.name = name;
		this.customId = optionsWithDefaults.customId;
		this.lastModified = optionsWithDefaults.lastModified;
	}
};

//#endregion
//#region src/_internal/upload-server.ts
const uploadWithoutProgress = (file, presigned) => effect_Effect.gen(function* () {
	const formData = new FormData();
	formData.append("file", file);
	const httpClient = (yield* __effect_platform_HttpClient.HttpClient).pipe(__effect_platform_HttpClient.filterStatusOk);
	const json = yield* __effect_platform_HttpClientRequest.put(presigned.url).pipe(__effect_platform_HttpClientRequest.bodyFormData(formData), __effect_platform_HttpClientRequest.setHeader("Range", "bytes=0-"), __effect_platform_HttpClientRequest.setHeader("x-uploadthing-version", require_package.version), httpClient.execute, effect_Effect.tapError(require_upload_builder.logHttpClientError("Failed to upload file")), effect_Effect.mapError((e) => new __uploadthing_shared.UploadThingError({
		code: "UPLOAD_FAILED",
		message: "Failed to upload file",
		cause: e
	})), effect_Effect.andThen((_) => _.json), effect_Effect.andThen(effect_Function.unsafeCoerce), effect_Effect.scoped);
	yield* effect_Effect.logDebug(`File ${file.name} uploaded successfully`).pipe(effect_Effect.annotateLogs("json", json));
	return {
		...json,
		get url() {
			require_deprecations.logDeprecationWarning("`file.url` is deprecated and will be removed in uploadthing v9. Use `file.ufsUrl` instead.");
			return json.url;
		},
		get appUrl() {
			require_deprecations.logDeprecationWarning("`file.appUrl` is deprecated and will be removed in uploadthing v9. Use `file.ufsUrl` instead.");
			return json.appUrl;
		}
	};
});

//#endregion
//#region src/sdk/utils.ts
function guardServerOnly() {
	if (typeof window !== "undefined") throw new __uploadthing_shared.UploadThingError({
		code: "INTERNAL_SERVER_ERROR",
		message: "The `utapi` can only be used on the server."
	});
}
const downloadFile = (_url) => effect_Effect.gen(function* () {
	let url = effect_Predicate.isRecord(_url) ? _url.url : _url;
	if (typeof url === "string") {
		if (url.startsWith("data:")) return yield* effect_Effect.fail({
			code: "BAD_REQUEST",
			message: "Please use uploadFiles() for data URLs. uploadFilesFromUrl() is intended for use with remote URLs only.",
			data: void 0
		});
	}
	url = new URL(url);
	const { name = url.pathname.split("/").pop() ?? "unknown-filename", customId = void 0 } = effect_Predicate.isRecord(_url) ? _url : {};
	const httpClient = (yield* __effect_platform_HttpClient.HttpClient).pipe(__effect_platform_HttpClient.filterStatusOk);
	const arrayBuffer = yield* __effect_platform_HttpClientRequest.get(url).pipe(__effect_platform_HttpClientRequest.modify({ headers: {} }), httpClient.execute, effect_Effect.flatMap((_) => _.arrayBuffer), effect_Effect.mapError((cause) => {
		return {
			code: "BAD_REQUEST",
			message: `Failed to download requested file: ${cause.message}`,
			data: cause.toJSON()
		};
	}), effect_Effect.scoped);
	return new UTFile([arrayBuffer], name, {
		customId,
		lastModified: Date.now()
	});
}).pipe(effect_Effect.withLogSpan("downloadFile"));
const generatePresignedUrl = (file, cd, acl) => effect_Effect.gen(function* () {
	const { apiKey, appId } = yield* require_upload_builder.UTToken;
	const baseUrl = yield* require_upload_builder.IngestUrl(void 0);
	const key = yield* (0, __uploadthing_shared.generateKey)(file, appId);
	const url = yield* (0, __uploadthing_shared.generateSignedURL)(`${baseUrl}/${key}`, apiKey, { data: {
		"x-ut-identifier": appId,
		"x-ut-file-name": file.name,
		"x-ut-file-size": file.size,
		"x-ut-file-type": file.type,
		"x-ut-custom-id": file.customId,
		"x-ut-content-disposition": cd,
		"x-ut-acl": acl
	} });
	return {
		url,
		key
	};
}).pipe(effect_Effect.withLogSpan("generatePresignedUrl"));
const uploadFile = (file, opts) => effect_Effect.gen(function* () {
	const presigned = yield* generatePresignedUrl(file, opts.contentDisposition ?? "inline", opts.acl).pipe(effect_Effect.catchTag("UploadThingError", (e) => effect_Effect.fail(__uploadthing_shared.UploadThingError.toObject(e))), effect_Effect.catchTag("ConfigError", () => effect_Effect.fail({
		code: "INVALID_SERVER_CONFIG",
		message: "Failed to generate presigned URL"
	})));
	const response = yield* uploadWithoutProgress(file, presigned).pipe(effect_Effect.catchTag("UploadThingError", (e) => effect_Effect.fail(__uploadthing_shared.UploadThingError.toObject(e))), effect_Effect.catchTag("ResponseError", (e) => effect_Effect.fail({
		code: "UPLOAD_FAILED",
		message: "Failed to upload file",
		data: e.toJSON()
	})));
	return {
		key: presigned.key,
		url: response.url,
		appUrl: response.appUrl,
		ufsUrl: response.ufsUrl,
		lastModified: file.lastModified ?? Date.now(),
		name: file.name,
		size: file.size,
		type: file.type,
		customId: file.customId ?? null,
		fileHash: response.fileHash
	};
}).pipe(effect_Effect.withLogSpan("uploadFile"));

//#endregion
//#region src/sdk/index.ts
var UTApi = class {
	fetch;
	defaultKeyType;
	runtime;
	opts;
	constructor(options) {
		guardServerOnly();
		this.opts = options ?? {};
		this.fetch = this.opts.fetch ?? globalThis.fetch;
		this.defaultKeyType = this.opts.defaultKeyType ?? "fileKey";
		this.runtime = require_upload_builder.makeRuntime(this.fetch, this.opts);
	}
	requestUploadThing = (pathname, body, responseSchema) => effect_Effect.gen(this, function* () {
		const { apiKey } = yield* require_upload_builder.UTToken;
		const baseUrl = yield* require_upload_builder.ApiUrl;
		const httpClient = (yield* __effect_platform_HttpClient.HttpClient).pipe(__effect_platform_HttpClient.filterStatusOk);
		return yield* __effect_platform_HttpClientRequest.post(pathname).pipe(__effect_platform_HttpClientRequest.prependUrl(baseUrl), __effect_platform_HttpClientRequest.bodyUnsafeJson(body), __effect_platform_HttpClientRequest.setHeaders({
			"x-uploadthing-version": require_package.version,
			"x-uploadthing-be-adapter": "server-sdk",
			"x-uploadthing-api-key": effect_Redacted.value(apiKey)
		}), httpClient.execute, effect_Effect.tapBoth({
			onSuccess: require_upload_builder.logHttpClientResponse("UploadThing API Response"),
			onFailure: require_upload_builder.logHttpClientError("Failed to request UploadThing API")
		}), effect_Effect.flatMap(__effect_platform_HttpClientResponse.schemaBodyJson(responseSchema)), effect_Effect.scoped);
	}).pipe(effect_Effect.catchTag("ConfigError", (e) => new __uploadthing_shared.UploadThingError({
		code: "INVALID_SERVER_CONFIG",
		message: "There was an error with the server configuration. More info can be found on this error's `cause` property",
		cause: e
	})), effect_Effect.withLogSpan("utapi.#requestUploadThing"));
	executeAsync = async (program, signal) => {
		const exit = await program.pipe(effect_Effect.withLogSpan("utapi.#executeAsync"), (e) => this.runtime.runPromiseExit(e, signal ? { signal } : void 0));
		if (exit._tag === "Failure") throw effect_Cause.squash(exit.cause);
		return exit.value;
	};
	uploadFiles(files, opts) {
		guardServerOnly();
		const concurrency = opts?.concurrency ?? 1;
		if (concurrency < 1 || concurrency > 25) throw new __uploadthing_shared.UploadThingError({
			code: "BAD_REQUEST",
			message: "concurrency must be a positive integer between 1 and 25"
		});
		const program = effect_Effect.forEach(effect_Array.ensure(files), (file) => uploadFile(file, opts ?? {}).pipe(effect_Effect.match({
			onSuccess: (data) => ({
				data,
				error: null
			}),
			onFailure: (error) => ({
				data: null,
				error
			})
		})), { concurrency }).pipe(effect_Effect.map((ups) => Array.isArray(files) ? ups : ups[0]), effect_Effect.tap((res) => effect_Effect.logDebug("Finished uploading").pipe(effect_Effect.annotateLogs("uploadResult", res))), effect_Effect.withLogSpan("uploadFiles"));
		return this.executeAsync(program, opts?.signal);
	}
	uploadFilesFromUrl(urls, opts) {
		guardServerOnly();
		const concurrency = opts?.concurrency ?? 1;
		if (concurrency < 1 || concurrency > 25) throw new __uploadthing_shared.UploadThingError({
			code: "BAD_REQUEST",
			message: "concurrency must be a positive integer between 1 and 25"
		});
		const program = effect_Effect.forEach(effect_Array.ensure(urls), (url) => downloadFile(url).pipe(effect_Effect.flatMap((file) => uploadFile(file, opts ?? {})), effect_Effect.match({
			onSuccess: (data) => ({
				data,
				error: null
			}),
			onFailure: (error) => ({
				data: null,
				error
			})
		})), { concurrency }).pipe(effect_Effect.map((ups) => Array.isArray(urls) ? ups : ups[0]), effect_Effect.tap((res) => effect_Effect.logDebug("Finished uploading").pipe(effect_Effect.annotateLogs("uploadResult", res))), effect_Effect.withLogSpan("uploadFiles")).pipe(effect_Effect.withLogSpan("uploadFilesFromUrl"));
		return this.executeAsync(program, opts?.signal);
	}
	/**
	* Request to delete files from UploadThing storage.
	* @param {string | string[]} fileKeys
	*
	* @example
	* await deleteFiles("2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg");
	*
	* @example
	* await deleteFiles(["2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg","1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"])
	*
	* @example
	* await deleteFiles("myCustomIdentifier", { keyType: "customId" })
	*/
	deleteFiles = async (keys, opts) => {
		guardServerOnly();
		const { keyType = this.defaultKeyType } = opts ?? {};
		class DeleteFileResponse extends effect_Schema.Class("DeleteFileResponse")({
			success: effect_Schema.Boolean,
			deletedCount: effect_Schema.Number
		}) {}
		return await this.executeAsync(this.requestUploadThing("/v6/deleteFiles", keyType === "fileKey" ? { fileKeys: effect_Array.ensure(keys) } : { customIds: effect_Array.ensure(keys) }, DeleteFileResponse).pipe(effect_Effect.withLogSpan("deleteFiles")));
	};
	/**
	* Request file URLs from UploadThing storage.
	* @param {string | string[]} fileKeys
	*
	* @example
	* const data = await getFileUrls("2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg");
	* console.log(data); // [{key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", url: "https://uploadthing.com/f/2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg"}]
	*
	* @example
	* const data = await getFileUrls(["2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg","1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"])
	* console.log(data) // [{key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", url: "https://uploadthing.com/f/2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg" },{key: "1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg", url: "https://uploadthing.com/f/1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"}]
	*
	* @deprecated - See https://docs.uploadthing.com/working-with-files#accessing-files for info how to access files
	*/
	getFileUrls = async (keys, opts) => {
		guardServerOnly();
		const { keyType = this.defaultKeyType } = opts ?? {};
		class GetFileUrlResponse extends effect_Schema.Class("GetFileUrlResponse")({ data: effect_Schema.Array(effect_Schema.Struct({
			key: effect_Schema.String,
			url: effect_Schema.String
		})) }) {}
		return await this.executeAsync(this.requestUploadThing("/v6/getFileUrl", keyType === "fileKey" ? { fileKeys: effect_Array.ensure(keys) } : { customIds: effect_Array.ensure(keys) }, GetFileUrlResponse).pipe(effect_Effect.withLogSpan("getFileUrls")));
	};
	/**
	* Request file list from UploadThing storage.
	* @param {object} opts
	* @param {number} opts.limit The maximum number of files to return
	* @param {number} opts.offset The number of files to skip
	*
	* @example
	* const data = await listFiles({ limit: 1 });
	* console.log(data); // { key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", id: "2e0fdb64-9957-4262-8e45-f372ba903ac8" }
	*/
	listFiles = async (opts) => {
		guardServerOnly();
		class ListFileResponse extends effect_Schema.Class("ListFileResponse")({
			hasMore: effect_Schema.Boolean,
			files: effect_Schema.Array(effect_Schema.Struct({
				id: effect_Schema.String,
				customId: effect_Schema.NullOr(effect_Schema.String),
				key: effect_Schema.String,
				name: effect_Schema.String,
				size: effect_Schema.Number,
				status: effect_Schema.Literal("Deletion Pending", "Failed", "Uploaded", "Uploading"),
				uploadedAt: effect_Schema.Number
			}))
		}) {}
		return await this.executeAsync(this.requestUploadThing("/v6/listFiles", { ...opts }, ListFileResponse).pipe(effect_Effect.withLogSpan("listFiles")));
	};
	renameFiles = async (updates) => {
		guardServerOnly();
		class RenameFileResponse extends effect_Schema.Class("RenameFileResponse")({ success: effect_Schema.Boolean }) {}
		return await this.executeAsync(this.requestUploadThing("/v6/renameFiles", { updates: effect_Array.ensure(updates) }, RenameFileResponse).pipe(effect_Effect.withLogSpan("renameFiles")));
	};
	getUsageInfo = async () => {
		guardServerOnly();
		class GetUsageInfoResponse extends effect_Schema.Class("GetUsageInfoResponse")({
			totalBytes: effect_Schema.Number,
			appTotalBytes: effect_Schema.Number,
			filesUploaded: effect_Schema.Number,
			limitBytes: effect_Schema.Number
		}) {}
		return await this.executeAsync(this.requestUploadThing("/v6/getUsageInfo", {}, GetUsageInfoResponse).pipe(effect_Effect.withLogSpan("getUsageInfo")));
	};
	/**
	* Generate a presigned url for a private file
	* Unlike {@link getSignedURL}, this method does not make a fetch request to the UploadThing API
	* and is the recommended way to generate a presigned url for a private file.
	**/
	generateSignedURL = async (key, opts) => {
		guardServerOnly();
		const expiresIn = (0, __uploadthing_shared.parseTimeToSeconds)(opts?.expiresIn ?? "5 minutes");
		if (opts?.expiresIn && isNaN(expiresIn)) throw new __uploadthing_shared.UploadThingError({
			code: "BAD_REQUEST",
			message: "expiresIn must be a valid time string, for example '1d', '2 days', or a number of seconds."
		});
		if (expiresIn > 86400 * 7) throw new __uploadthing_shared.UploadThingError({
			code: "BAD_REQUEST",
			message: "expiresIn must be less than 7 days (604800 seconds)."
		});
		const program = effect_Effect.gen(function* () {
			const { apiKey, appId } = yield* require_upload_builder.UTToken;
			const appIdLocation = yield* require_upload_builder.UfsAppIdLocation;
			const ufsHost = yield* require_upload_builder.UfsHost;
			const proto = ufsHost.includes("local") ? "http" : "https";
			const urlBase = appIdLocation === "subdomain" ? `${proto}://${appId}.${ufsHost}/f/${key}` : `${proto}://${ufsHost}/a/${appId}/${key}`;
			const ufsUrl = yield* (0, __uploadthing_shared.generateSignedURL)(urlBase, apiKey, { ttlInSeconds: expiresIn });
			return { ufsUrl };
		});
		return await this.executeAsync(program.pipe(effect_Effect.catchTag("ConfigError", (e) => new __uploadthing_shared.UploadThingError({
			code: "INVALID_SERVER_CONFIG",
			message: "There was an error with the server configuration. More info can be found on this error's `cause` property",
			cause: e
		})), effect_Effect.withLogSpan("generateSignedURL")));
	};
	/**
	* Request a presigned url for a private file(s)
	* @remarks This method is no longer recommended as it makes a fetch
	* request to the UploadThing API which incurs redundant latency. It
	* will be deprecated in UploadThing v8 and removed in UploadThing v9.
	*
	* @see {@link generateSignedURL} for a more efficient way to generate a presigned url
	**/
	getSignedURL = async (key, opts) => {
		guardServerOnly();
		const expiresIn = opts?.expiresIn ? (0, __uploadthing_shared.parseTimeToSeconds)(opts.expiresIn) : void 0;
		const { keyType = this.defaultKeyType } = opts ?? {};
		if (opts?.expiresIn && isNaN(expiresIn)) throw new __uploadthing_shared.UploadThingError({
			code: "BAD_REQUEST",
			message: "expiresIn must be a valid time string, for example '1d', '2 days', or a number of seconds."
		});
		if (expiresIn && expiresIn > 86400 * 7) throw new __uploadthing_shared.UploadThingError({
			code: "BAD_REQUEST",
			message: "expiresIn must be less than 7 days (604800 seconds)."
		});
		class GetSignedUrlResponse extends effect_Schema.Class("GetSignedUrlResponse")({
			url: effect_Schema.String,
			ufsUrl: effect_Schema.String
		}) {}
		return await this.executeAsync(this.requestUploadThing("/v6/requestFileAccess", keyType === "fileKey" ? {
			fileKey: key,
			expiresIn
		} : {
			customId: key,
			expiresIn
		}, GetSignedUrlResponse).pipe(effect_Effect.withLogSpan("getSignedURL")));
	};
	/**
	* Update the ACL of a file or set of files.
	*
	* @example
	* // Make a single file public
	* await utapi.updateACL("2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", "public-read");
	*
	* // Make multiple files private
	* await utapi.updateACL(
	*   [
	*     "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg",
	*     "1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg",
	*   ],
	*   "private",
	* );
	*/
	updateACL = async (keys, acl, opts) => {
		guardServerOnly();
		const { keyType = this.defaultKeyType } = opts ?? {};
		const updates = effect_Array.ensure(keys).map((key) => {
			return keyType === "fileKey" ? {
				fileKey: key,
				acl
			} : {
				customId: key,
				acl
			};
		});
		const responseSchema = effect_Schema.Struct({ success: effect_Schema.Boolean });
		return await this.executeAsync(this.requestUploadThing("/v6/updateACL", { updates }, responseSchema).pipe(effect_Effect.withLogSpan("updateACL")));
	};
};

//#endregion
//#region src/server.ts
const createUploadthing = (opts) => require_upload_builder.createBuilder(opts);
const createRouteHandler = (opts) => {
	return require_upload_builder.makeAdapterHandler((ev) => effect_Effect.succeed({ req: "request" in ev ? ev.request : ev }), (ev) => effect_Effect.succeed("request" in ev ? ev.request : ev), opts, "server");
};
const extractRouterConfig$1 = (router) => effect_Effect.runSync(require_upload_builder.extractRouterConfig(router));

//#endregion
exports.UTApi = UTApi;
exports.UTFile = UTFile;
exports.UTFiles = require_upload_builder.UTFiles;
exports.UploadThingError = __uploadthing_shared.UploadThingError;
exports.createBuilder = require_upload_builder.createBuilder;
exports.createRouteHandler = createRouteHandler;
exports.createUploadthing = createUploadthing;
exports.experimental_UTRegion = require_upload_builder.UTRegion;
exports.extractRouterConfig = extractRouterConfig$1;
exports.makeAdapterHandler = require_upload_builder.makeAdapterHandler;