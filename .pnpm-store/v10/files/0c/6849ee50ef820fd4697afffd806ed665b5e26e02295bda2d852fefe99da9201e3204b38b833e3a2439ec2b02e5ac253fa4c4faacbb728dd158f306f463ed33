import * as Micro from "effect/Micro";
import { lookup } from "@uploadthing/mime-types";
import * as Predicate from "effect/Predicate";
import * as Context from "effect/Context";
import { audio } from "@uploadthing/mime-types/audio";
import { image } from "@uploadthing/mime-types/image";
import { text } from "@uploadthing/mime-types/text";
import { video } from "@uploadthing/mime-types/video";
import * as Encoding from "effect/Encoding";
import * as Hash from "effect/Hash";
import * as Redacted from "effect/Redacted";
import SQIds, { defaultOptions } from "sqids";

//#region src/types.ts
const ValidContentDispositions = ["inline", "attachment"];
const ValidACLs = ["public-read", "private"];

//#endregion
//#region src/tagged-errors.ts
var InvalidRouteConfigError = class extends Micro.TaggedError("InvalidRouteConfig") {
	constructor(type, field) {
		const reason = field ? `Expected route config to have a ${field} for key ${type} but none was found.` : `Encountered an invalid route config during backfilling. ${type} was not found.`;
		super({ reason });
	}
};
var UnknownFileTypeError = class extends Micro.TaggedError("UnknownFileType") {
	constructor(fileName) {
		const reason = `Could not determine type for ${fileName}`;
		super({ reason });
	}
};
var InvalidFileTypeError = class extends Micro.TaggedError("InvalidFileType") {
	constructor(fileType, fileName) {
		const reason = `File type ${fileType} not allowed for ${fileName}`;
		super({ reason });
	}
};
var InvalidFileSizeError = class extends Micro.TaggedError("InvalidFileSize") {
	constructor(fileSize) {
		const reason = `Invalid file size: ${fileSize}`;
		super({ reason });
	}
};
var InvalidURLError = class extends Micro.TaggedError("InvalidURL") {
	constructor(attemptedUrl) {
		super({ reason: `Failed to parse '${attemptedUrl}' as a URL.` });
	}
};
var RetryError = class extends Micro.TaggedError("RetryError") {};
var FetchError = class extends Micro.TaggedError("FetchError") {};
var InvalidJsonError = class extends Micro.TaggedError("InvalidJson") {};
var BadRequestError = class extends Micro.TaggedError("BadRequestError") {
	getMessage() {
		if (Predicate.isRecord(this.json)) {
			if (typeof this.json.message === "string") return this.json.message;
		}
		return this.message;
	}
};
var UploadPausedError = class extends Micro.TaggedError("UploadAborted") {};
var UploadAbortedError = class extends Micro.TaggedError("UploadAborted") {};

//#endregion
//#region src/utils.ts
function isRouteArray(routeConfig) {
	return Array.isArray(routeConfig);
}
function getDefaultSizeForType(fileType) {
	if (fileType === "image") return "4MB";
	if (fileType === "video") return "16MB";
	if (fileType === "audio") return "8MB";
	if (fileType === "blob") return "8MB";
	if (fileType === "pdf") return "4MB";
	if (fileType === "text") return "64KB";
	return "4MB";
}
function getDefaultRouteConfigValues(type) {
	return {
		maxFileSize: getDefaultSizeForType(type),
		maxFileCount: 1,
		minFileCount: 1,
		contentDisposition: "inline"
	};
}
/**
* This function takes in the user's input and "upscales" it to a full config
* Additionally, it replaces numbers with "safe" equivalents
*
* Example:
* ```ts
* ["image"] => { image: { maxFileSize: "4MB", limit: 1 } }
* ```
*/
const fillInputRouteConfig = (routeConfig) => {
	if (isRouteArray(routeConfig)) return Micro.succeed(routeConfig.reduce((acc, fileType) => {
		acc[fileType] = getDefaultRouteConfigValues(fileType);
		return acc;
	}, {}));
	const newConfig = {};
	for (const key of objectKeys(routeConfig)) {
		const value = routeConfig[key];
		if (!value) return Micro.fail(new InvalidRouteConfigError(key));
		newConfig[key] = {
			...getDefaultRouteConfigValues(key),
			...value
		};
	}
	return Micro.succeed(JSON.parse(JSON.stringify(newConfig, safeNumberReplacer)));
};
/**
* Match the file's type for a given allow list e.g. `image/png => image`
* Prefers the file's type, then falls back to a extension-based lookup
*/
const matchFileType = (file, allowedTypes) => {
	const mimeType = file.type || lookup(file.name);
	if (!mimeType) {
		if (allowedTypes.includes("blob")) return Micro.succeed("blob");
		return Micro.fail(new UnknownFileTypeError(file.name));
	}
	if (allowedTypes.some((type$1) => type$1.includes("/"))) {
		if (allowedTypes.includes(mimeType)) return Micro.succeed(mimeType);
	}
	const type = mimeType.toLowerCase() === "application/pdf" ? "pdf" : mimeType.split("/")[0];
	if (!allowedTypes.includes(type)) if (allowedTypes.includes("blob")) return Micro.succeed("blob");
	else return Micro.fail(new InvalidFileTypeError(type, file.name));
	return Micro.succeed(type);
};
const FILESIZE_UNITS = [
	"B",
	"KB",
	"MB",
	"GB",
	"TB"
];
const fileSizeToBytes = (fileSize) => {
	const regex = new RegExp(`^(\\d+)(\\.\\d+)?\\s*(${FILESIZE_UNITS.join("|")})$`, "i");
	const match = fileSize.match(regex);
	if (!match?.[1] || !match[3]) return Micro.fail(new InvalidFileSizeError(fileSize));
	const sizeValue = parseFloat(match[1]);
	const sizeUnit = match[3].toUpperCase();
	const bytes = sizeValue * Math.pow(1024, FILESIZE_UNITS.indexOf(sizeUnit));
	return Micro.succeed(Math.floor(bytes));
};
const bytesToFileSize = (bytes) => {
	if (bytes === 0 || bytes === -1) return "0B";
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(2)}${FILESIZE_UNITS[i]}`;
};
async function safeParseJSON(input) {
	const text$1 = await input.text();
	try {
		return JSON.parse(text$1);
	} catch (err) {
		console.error(`Error parsing JSON, got '${text$1}'`, err);
		return /* @__PURE__ */ new Error(`Error parsing JSON, got '${text$1}'`);
	}
}
/** typesafe Object.keys */
function objectKeys(obj) {
	return Object.keys(obj);
}
function filterDefinedObjectValues(obj) {
	return Object.fromEntries(Object.entries(obj).filter((pair) => pair[1] != null));
}
function semverLite(required, toCheck) {
	const semverRegex = /(\d+)\.?(\d+)?\.?(\d+)?/;
	const requiredMatch = semverRegex.exec(required);
	if (!requiredMatch?.[0]) throw new Error(`Invalid semver requirement: ${required}`);
	const toCheckMatch = semverRegex.exec(toCheck);
	if (!toCheckMatch?.[0]) throw new Error(`Invalid semver to check: ${toCheck}`);
	const [_1, rMajor, rMinor, rPatch] = requiredMatch;
	const [_2, cMajor, cMinor, cPatch] = toCheckMatch;
	if (required.startsWith("^")) {
		if (rMajor !== cMajor) return false;
		if (rMinor && cMinor && rMinor > cMinor) return false;
		return true;
	}
	if (required.startsWith("~")) {
		if (rMajor !== cMajor) return false;
		if (rMinor !== cMinor) return false;
		return true;
	}
	return rMajor === cMajor && rMinor === cMinor && rPatch === cPatch;
}
function warnIfInvalidPeerDependency(pkg, required, toCheck) {
	if (!semverLite(required, toCheck)) console.warn(`!!!WARNING::: ${pkg} requires "uploadthing@${required}", but version "${toCheck}" is installed`);
}
const getRequestUrl = (req) => Micro.gen(function* () {
	const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
	const proto = req.headers.get("x-forwarded-proto") ?? "https";
	const protocol = proto.endsWith(":") ? proto : `${proto}:`;
	const url = yield* Micro.try({
		try: () => new URL(req.url, `${protocol}//${host}`),
		catch: () => new InvalidURLError(req.url)
	});
	url.search = "";
	return url;
});
const getFullApiUrl = (maybeUrl) => Micro.gen(function* () {
	const base = (() => {
		if (typeof window !== "undefined") return window.location.origin;
		if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
		return "http://localhost:3000";
	})();
	const url = yield* Micro.try({
		try: () => new URL(maybeUrl ?? "/api/uploadthing", base),
		catch: () => new InvalidURLError(maybeUrl ?? "/api/uploadthing")
	});
	if (url.pathname === "/") url.pathname = "/api/uploadthing";
	return url;
});
const resolveMaybeUrlArg = (maybeUrl) => {
	return maybeUrl instanceof URL ? maybeUrl : Micro.runSync(getFullApiUrl(maybeUrl));
};
function parseTimeToSeconds(time) {
	if (typeof time === "number") return time;
	const match = time.split(/(\d+)/).filter(Boolean);
	const num = Number(match[0]);
	const unit = (match[1] ?? "s").trim().slice(0, 1);
	const multiplier = {
		s: 1,
		m: 60,
		h: 3600,
		d: 86400
	}[unit];
	return num * multiplier;
}
/**
* Replacer for JSON.stringify that will replace numbers that cannot be
* serialized to JSON with "reasonable equivalents".
*
* Infinity and -Infinity are replaced by MAX_SAFE_INTEGER and MIN_SAFE_INTEGER
* NaN is replaced by 0
*
*/
const safeNumberReplacer = (_, value) => {
	if (typeof value !== "number") return value;
	if (Number.isSafeInteger(value) || value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER) return value;
	if (value === Infinity) return Number.MAX_SAFE_INTEGER;
	if (value === -Infinity) return Number.MIN_SAFE_INTEGER;
	if (Number.isNaN(value)) return 0;
};
function noop() {}
function createIdentityProxy() {
	return new Proxy(noop, { get: (_, prop) => prop });
}
function unwrap(x, ...args) {
	return typeof x === "function" ? x(...args) : x;
}

//#endregion
//#region src/file-types.ts
const ALLOWED_FILE_TYPES = [
	"image",
	"video",
	"audio",
	"pdf",
	"text",
	"blob"
];

//#endregion
//#region src/error.ts
const ERROR_CODES = {
	BAD_REQUEST: 400,
	NOT_FOUND: 404,
	FORBIDDEN: 403,
	INTERNAL_SERVER_ERROR: 500,
	INTERNAL_CLIENT_ERROR: 500,
	TOO_LARGE: 413,
	TOO_SMALL: 400,
	TOO_MANY_FILES: 400,
	KEY_TOO_LONG: 400,
	URL_GENERATION_FAILED: 500,
	UPLOAD_FAILED: 500,
	MISSING_ENV: 500,
	INVALID_SERVER_CONFIG: 500,
	FILE_LIMIT_EXCEEDED: 500
};
function messageFromUnknown(cause, fallback) {
	if (typeof cause === "string") return cause;
	if (cause instanceof Error) return cause.message;
	if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
	return fallback ?? "An unknown error occurred";
}
var UploadThingError = class UploadThingError extends Micro.Error {
	_tag = "UploadThingError";
	name = "UploadThingError";
	cause;
	code;
	data;
	constructor(initOpts) {
		const opts = typeof initOpts === "string" ? {
			code: "INTERNAL_SERVER_ERROR",
			message: initOpts
		} : initOpts;
		const message = opts.message ?? messageFromUnknown(opts.cause, opts.code);
		super({ message });
		this.code = opts.code;
		this.data = opts.data;
		if (opts.cause instanceof Error) this.cause = opts.cause;
		else if (Predicate.isRecord(opts.cause) && Predicate.isNumber(opts.cause.status) && Predicate.isString(opts.cause.statusText)) this.cause = /* @__PURE__ */ new Error(`Response ${opts.cause.status} ${opts.cause.statusText}`);
		else if (Predicate.isString(opts.cause)) this.cause = new Error(opts.cause);
		else this.cause = opts.cause;
	}
	static toObject(error) {
		return {
			code: error.code,
			message: error.message,
			data: error.data
		};
	}
	static serialize(error) {
		return JSON.stringify(UploadThingError.toObject(error));
	}
};
function getErrorTypeFromStatusCode(statusCode) {
	for (const [code, status] of Object.entries(ERROR_CODES)) if (status === statusCode) return code;
	return "INTERNAL_SERVER_ERROR";
}
function getStatusCodeFromError(error) {
	return ERROR_CODES[error.code];
}
const INTERNAL_DO_NOT_USE__fatalClientError = (e) => new UploadThingError({
	code: "INTERNAL_CLIENT_ERROR",
	message: "Something went wrong. Please report this to UploadThing.",
	cause: e
});

//#endregion
//#region src/effect.ts
var FetchContext = class extends Context.Tag("uploadthing/Fetch")() {};
const fetchEff = (input, init) => Micro.flatMap(Micro.service(FetchContext), (fetch) => {
	const headers = new Headers(init?.headers ?? []);
	const reqInfo = {
		url: input.toString(),
		method: init?.method,
		body: init?.body,
		headers: Object.fromEntries(headers)
	};
	return Micro.tryPromise({
		try: (signal) => fetch(input, {
			...init,
			headers,
			signal
		}),
		catch: (error) => new FetchError({
			error: error instanceof Error ? {
				...error,
				name: error.name,
				message: error.message,
				stack: error.stack
			} : error,
			input: reqInfo
		})
	}).pipe(Micro.tapError((e) => Micro.sync(() => console.error(e.input))), Micro.map((res) => Object.assign(res, { requestUrl: reqInfo.url })), Micro.withTrace("fetch"));
});
const parseResponseJson = (res) => Micro.tryPromise({
	try: async () => {
		const json = await res.json();
		return {
			json,
			ok: res.ok,
			status: res.status
		};
	},
	catch: (error) => new InvalidJsonError({
		error,
		input: res.requestUrl
	})
}).pipe(Micro.filterOrFail(({ ok }) => ok, ({ json, status }) => new BadRequestError({
	status,
	message: `Request to ${res.requestUrl} failed with status ${status}`,
	json
})), Micro.map(({ json }) => json), Micro.withTrace("parseJson"));

//#endregion
//#region src/component-utils.ts
const roundProgress = (progress, granularity) => {
	if (granularity === "all") return progress;
	if (granularity === "fine") return Math.round(progress);
	return Math.floor(progress / 10) * 10;
};
const generateMimeTypes = (typesOrRouteConfig) => {
	const fileTypes = Array.isArray(typesOrRouteConfig) ? typesOrRouteConfig : objectKeys(typesOrRouteConfig);
	if (fileTypes.includes("blob")) return [];
	return fileTypes.map((type) => {
		if (type === "pdf") return "application/pdf";
		if (type.includes("/")) return type;
		if (type === "audio") return ["audio/*", ...objectKeys(audio)].join(", ");
		if (type === "image") return ["image/*", ...objectKeys(image)].join(", ");
		if (type === "text") return ["text/*", ...objectKeys(text)].join(", ");
		if (type === "video") return ["video/*", ...objectKeys(video)].join(", ");
		return `${type}/*`;
	});
};
const generateClientDropzoneAccept = (fileTypes) => {
	const mimeTypes = generateMimeTypes(fileTypes);
	return Object.fromEntries(mimeTypes.map((type) => [type, []]));
};
function getFilesFromClipboardEvent(event) {
	const dataTransferItems = event.clipboardData?.items;
	if (!dataTransferItems) return;
	const files = Array.from(dataTransferItems).reduce((acc, curr) => {
		const f = curr.getAsFile();
		return f ? [...acc, f] : acc;
	}, []);
	return files;
}
/**
* Shared helpers for our premade components that's reusable by multiple frameworks
*/
const generatePermittedFileTypes = (config) => {
	const fileTypes = config ? objectKeys(config) : [];
	const maxFileCount = config ? Object.values(config).map((v) => v.maxFileCount) : [];
	return {
		fileTypes,
		multiple: maxFileCount.some((v) => v && v > 1)
	};
};
const capitalizeStart = (str) => {
	return str.charAt(0).toUpperCase() + str.slice(1);
};
const INTERNAL_doFormatting = (config) => {
	if (!config) return "";
	const allowedTypes = objectKeys(config);
	const formattedTypes = allowedTypes.map((f) => f === "blob" ? "file" : f);
	if (formattedTypes.length > 1) {
		const lastType = formattedTypes.pop();
		return `${formattedTypes.join("s, ")} and ${lastType}s`;
	}
	const key = allowedTypes[0];
	const formattedKey = formattedTypes[0];
	if (!key || !formattedKey) return "";
	const { maxFileSize, maxFileCount, minFileCount } = config[key];
	if (maxFileCount && maxFileCount > 1) if (minFileCount > 1) return `${minFileCount} - ${maxFileCount} ${formattedKey}s up to ${maxFileSize}`;
	else return `${formattedKey}s up to ${maxFileSize}, max ${maxFileCount}`;
	else return `${formattedKey} (${maxFileSize})`;
};
const allowedContentTextLabelGenerator = (config) => {
	return capitalizeStart(INTERNAL_doFormatting(config));
};
const styleFieldToClassName = (styleField, args) => {
	if (typeof styleField === "string") return styleField;
	if (typeof styleField === "function") {
		const result = styleField(args);
		if (typeof result === "string") return result;
	}
	return "";
};
const styleFieldToCssObject = (styleField, args) => {
	if (typeof styleField === "object") return styleField;
	if (typeof styleField === "function") {
		const result = styleField(args);
		if (typeof result === "object") return result;
	}
	return {};
};
const contentFieldToContent = (contentField, arg) => {
	if (!contentField) return null;
	if (typeof contentField !== "function") return contentField;
	if (typeof contentField === "function") {
		const result = contentField(arg);
		return result;
	}
};
const defaultClassListMerger = (...classes) => {
	return classes.filter(Boolean).join(" ");
};

//#endregion
//#region src/crypto.ts
const signaturePrefix = "hmac-sha256=";
const algorithm = {
	name: "HMAC",
	hash: "SHA-256"
};
const encoder = new TextEncoder();
function shuffle(str, seed) {
	const chars = str.split("");
	const seedNum = Hash.string(seed);
	let temp;
	let j;
	for (let i = 0; i < chars.length; i++) {
		j = (seedNum % (i + 1) + i) % chars.length;
		temp = chars[i];
		chars[i] = chars[j];
		chars[j] = temp;
	}
	return chars.join("");
}
const signPayload = (payload, secret) => Micro.gen(function* () {
	const signingKey = yield* Micro.tryPromise({
		try: () => crypto.subtle.importKey("raw", encoder.encode(Redacted.value(secret)), algorithm, false, ["sign"]),
		catch: (e) => new UploadThingError({
			code: "BAD_REQUEST",
			message: "Invalid signing secret",
			cause: e
		})
	});
	const signature = yield* Micro.map(Micro.tryPromise({
		try: () => crypto.subtle.sign(algorithm, signingKey, encoder.encode(payload)),
		catch: (e) => new UploadThingError({
			code: "BAD_REQUEST",
			cause: e
		})
	}), (arrayBuffer) => Encoding.encodeHex(new Uint8Array(arrayBuffer)));
	return `${signaturePrefix}${signature}`;
}).pipe(Micro.withTrace("signPayload"));
const verifySignature = (payload, signature, secret) => Micro.gen(function* () {
	const sig = signature?.slice(12);
	if (!sig) return false;
	const secretBytes = encoder.encode(Redacted.value(secret));
	const signingKey = yield* Micro.promise(() => crypto.subtle.importKey("raw", secretBytes, algorithm, false, ["verify"]));
	const sigBytes = yield* Micro.fromEither(Encoding.decodeHex(sig));
	const payloadBytes = encoder.encode(payload);
	return yield* Micro.promise(() => crypto.subtle.verify(algorithm, signingKey, sigBytes, payloadBytes));
}).pipe(Micro.withTrace("verifySignature"), Micro.orElseSucceed(() => false));
const generateKey = (file, appId, getHashParts) => Micro.sync(() => {
	const hashParts = JSON.stringify(getHashParts?.(file) ?? [
		file.name,
		file.size,
		file.type,
		file.lastModified,
		Date.now()
	]);
	const alphabet = shuffle(defaultOptions.alphabet, appId);
	const encodedFileSeed = new SQIds({
		alphabet,
		minLength: 36
	}).encode([Math.abs(Hash.string(hashParts))]);
	const encodedAppId = new SQIds({
		alphabet,
		minLength: 12
	}).encode([Math.abs(Hash.string(appId))]);
	return encodedAppId + encodedFileSeed;
}).pipe(Micro.withTrace("generateKey"));
const verifyKey = (key, appId) => Micro.sync(() => {
	const alphabet = shuffle(defaultOptions.alphabet, appId);
	const expectedPrefix = new SQIds({
		alphabet,
		minLength: 12
	}).encode([Math.abs(Hash.string(appId))]);
	return key.startsWith(expectedPrefix);
}).pipe(Micro.withTrace("verifyKey"), Micro.orElseSucceed(() => false));
const generateSignedURL = (url, secretKey, opts) => Micro.gen(function* () {
	const parsedURL = new URL(url);
	const ttl = opts.ttlInSeconds ? parseTimeToSeconds(opts.ttlInSeconds) : 3600;
	const expirationTime = Date.now() + ttl * 1e3;
	parsedURL.searchParams.append("expires", expirationTime.toString());
	if (opts.data) Object.entries(opts.data).forEach(([key, value]) => {
		if (value == null) return;
		const encoded = encodeURIComponent(value);
		parsedURL.searchParams.append(key, encoded);
	});
	const signature = yield* signPayload(parsedURL.toString(), secretKey);
	parsedURL.searchParams.append("signature", signature);
	return parsedURL.href;
}).pipe(Micro.withTrace("generateSignedURL"));

//#endregion
//#region src/dropzone-utils.ts
/**
* Copyright (c) (MIT License) 2015 Andrey Okonetchnikov
* https://github.com/react-dropzone/attr-accept/blob/master/src/index.js
*/
function accepts(file, acceptedFiles) {
	if (acceptedFiles) {
		const acceptedFilesArray = Array.isArray(acceptedFiles) ? acceptedFiles : acceptedFiles.split(",");
		const fileName = file.name;
		const mimeType = file.type.toLowerCase();
		const baseMimeType = mimeType.replace(/\/.*$/, "");
		return acceptedFilesArray.some((type) => {
			const validType = type.trim().toLowerCase();
			if (validType.startsWith(".")) return fileName.toLowerCase().endsWith(validType);
			else if (validType.endsWith("/*")) return baseMimeType === validType.replace(/\/.*$/, "");
			return mimeType === validType;
		});
	}
	return true;
}
const isPropagationStopped = (event) => {
	if (typeof event.isPropagationStopped === "function") return event.isPropagationStopped();
	if (typeof event.cancelBubble !== "undefined") return event.cancelBubble;
	return false;
};
function isFileAccepted(file, accept) {
	return file.type === "application/x-moz-file" || accepts(file, accept);
}
function isEnterOrSpace(event) {
	return "key" in event && (event.key === " " || event.key === "Enter") || "keyCode" in event && (event.keyCode === 32 || event.keyCode === 13);
}
const isDefined = (v) => v != null;
function isValidSize(file, minSize, maxSize) {
	if (!isDefined(file.size)) return true;
	if (isDefined(minSize) && isDefined(maxSize)) return file.size >= minSize && file.size <= maxSize;
	if (isDefined(minSize) && file.size < minSize) return false;
	if (isDefined(maxSize) && file.size > maxSize) return false;
	return true;
}
function isValidQuantity(files, multiple, maxFiles) {
	if (!multiple && files.length > 1) return false;
	if (multiple && maxFiles >= 1 && files.length > maxFiles) return false;
	return true;
}
function allFilesAccepted({ files, accept, minSize, maxSize, multiple, maxFiles }) {
	if (!isValidQuantity(files, multiple, maxFiles)) return false;
	return files.every((file) => isFileAccepted(file, accept) && isValidSize(file, minSize, maxSize));
}
function isEventWithFiles(event) {
	if (!("dataTransfer" in event && event.dataTransfer !== null)) return !!event.target && "files" in event.target && !!event.target.files;
	return Array.prototype.some.call(event.dataTransfer?.types, (type) => type === "Files" || type === "application/x-moz-file");
}
function isIeOrEdge(ua = window.navigator.userAgent) {
	return ua.includes("MSIE ") || ua.includes("Trident/") || ua.includes("Edge/");
}
function isMIMEType(v) {
	return v === "audio/*" || v === "video/*" || v === "image/*" || v === "text/*" || /\w+\/[-+.\w]+/g.test(v);
}
function isExt(v) {
	return /^.*\.[\w]+$/.test(v);
}
/**
* Convert the `{accept}` dropzone prop to an array of MIME types/extensions.
*/
function acceptPropAsAcceptAttr(accept) {
	if (isDefined(accept)) return Object.entries(accept).reduce((a, [mimeType, ext]) => [
		...a,
		mimeType,
		...ext
	], []).filter((v) => isMIMEType(v) || isExt(v)).join(",");
	return void 0;
}
const initialState = {
	isFocused: false,
	isFileDialogActive: false,
	isDragActive: false,
	isDragAccept: false,
	isDragReject: false,
	acceptedFiles: []
};
function reducer(state, action) {
	switch (action.type) {
		case "focus": return {
			...state,
			isFocused: true
		};
		case "blur": return {
			...state,
			isFocused: false
		};
		case "openDialog": return {
			...initialState,
			isFileDialogActive: true
		};
		case "closeDialog": return {
			...state,
			isFileDialogActive: false
		};
		case "setDraggedFiles": return {
			...state,
			...action.payload
		};
		case "setFiles": return {
			...state,
			...action.payload
		};
		case "reset": return initialState;
		default: return state;
	}
}

//#endregion
export { ALLOWED_FILE_TYPES, BadRequestError, FILESIZE_UNITS, FetchContext, FetchError, INTERNAL_DO_NOT_USE__fatalClientError, INTERNAL_doFormatting, InvalidFileSizeError, InvalidFileTypeError, InvalidJsonError, InvalidRouteConfigError, InvalidURLError, RetryError, UnknownFileTypeError, UploadAbortedError, UploadPausedError, UploadThingError, ValidACLs, ValidContentDispositions, acceptPropAsAcceptAttr, allFilesAccepted, allowedContentTextLabelGenerator, bytesToFileSize, capitalizeStart, contentFieldToContent, createIdentityProxy, defaultClassListMerger, fetchEff, fileSizeToBytes, fillInputRouteConfig, filterDefinedObjectValues, generateClientDropzoneAccept, generateKey, generateMimeTypes, generatePermittedFileTypes, generateSignedURL, getDefaultRouteConfigValues, getDefaultSizeForType, getErrorTypeFromStatusCode, getFilesFromClipboardEvent, getFullApiUrl, getRequestUrl, getStatusCodeFromError, initialState, isEnterOrSpace, isEventWithFiles, isFileAccepted, isIeOrEdge, isPropagationStopped, isRouteArray, isValidQuantity, isValidSize, matchFileType, noop, objectKeys, parseResponseJson, parseTimeToSeconds, reducer, resolveMaybeUrlArg, roundProgress, safeNumberReplacer, safeParseJSON, semverLite, signPayload, styleFieldToClassName, styleFieldToCssObject, unwrap, verifyKey, verifySignature, warnIfInvalidPeerDependency };
//# sourceMappingURL=index.js.map