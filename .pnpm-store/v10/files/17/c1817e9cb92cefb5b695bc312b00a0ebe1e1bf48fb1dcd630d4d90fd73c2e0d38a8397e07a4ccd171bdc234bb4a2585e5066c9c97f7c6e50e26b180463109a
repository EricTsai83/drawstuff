import { version } from "../dist/package-DpScpvTA.js";
import { createDeferred, createUTReporter, generateTraceHeaders } from "../dist/ut-reporter-Dlppchbx.js";
import { logDeprecationWarning } from "../dist/deprecations-pLmw6Ytd.js";
import * as Arr from "effect/Array";
import * as Micro from "effect/Micro";
import { FetchContext, UploadAbortedError, UploadAbortedError as UploadAbortedError$1, UploadPausedError, UploadPausedError as UploadPausedError$1, UploadThingError, allowedContentTextLabelGenerator, bytesToFileSize, createIdentityProxy, fetchEff, fileSizeToBytes, generateClientDropzoneAccept, generateMimeTypes, generatePermittedFileTypes, matchFileType, objectKeys, resolveMaybeUrlArg } from "@uploadthing/shared";
import { unsafeCoerce } from "effect/Function";
import { hasProperty, isRecord } from "effect/Predicate";

//#region src/_internal/upload-browser.ts
const uploadWithProgress = (file, rangeStart, presigned, opts) => Micro.async((resume) => {
	const xhr = new XMLHttpRequest();
	xhr.open("PUT", presigned.url, true);
	xhr.setRequestHeader("Range", `bytes=${rangeStart}-`);
	xhr.setRequestHeader("x-uploadthing-version", version);
	xhr.setRequestHeader("b3", opts.traceHeaders.b3);
	xhr.setRequestHeader("traceparent", opts.traceHeaders.traceparent);
	xhr.responseType = "json";
	let previousLoaded = 0;
	xhr.upload.addEventListener("progress", ({ loaded }) => {
		const delta = loaded - previousLoaded;
		opts.onUploadProgress?.({
			loaded,
			delta
		});
		previousLoaded = loaded;
	});
	xhr.addEventListener("load", () => {
		if (xhr.status >= 200 && xhr.status < 300 && isRecord(xhr.response)) if (hasProperty(xhr.response, "error")) resume(new UploadThingError({
			code: "UPLOAD_FAILED",
			message: String(xhr.response.error),
			data: xhr.response
		}));
		else resume(Micro.succeed(xhr.response));
		else resume(new UploadThingError({
			code: "UPLOAD_FAILED",
			message: `XHR failed ${xhr.status} ${xhr.statusText}`,
			data: xhr.response
		}));
	});
	xhr.addEventListener("error", () => {
		resume(new UploadThingError({ code: "UPLOAD_FAILED" }));
	});
	const formData = new FormData();
	/**
	* iOS/React Native FormData handling requires special attention:
	*
	* Issue: In React Native, iOS crashes with "attempt to insert nil object" when appending File directly
	* to FormData. This happens because iOS tries to create NSDictionary from the file object and expects
	* specific structure {uri, type, name}.
	*
	*
	* Note: Don't try to use Blob or modify File object - iOS specifically needs plain object
	* with these properties to create valid NSDictionary.
	*/
	if ("uri" in file) formData.append("file", {
		uri: file.uri,
		type: file.type,
		name: file.name,
		...rangeStart > 0 && { range: rangeStart }
	});
	else formData.append("file", rangeStart > 0 ? file.slice(rangeStart) : file);
	xhr.send(formData);
	return Micro.sync(() => xhr.abort());
});
const uploadFile = (file, presigned, opts) => fetchEff(presigned.url, {
	method: "HEAD",
	headers: opts.traceHeaders
}).pipe(Micro.map(({ headers }) => parseInt(headers.get("x-ut-range-start") ?? "0", 10)), Micro.tap((start) => opts.onUploadProgress?.({
	delta: start,
	loaded: start
})), Micro.flatMap((start) => uploadWithProgress(file, start, presigned, {
	traceHeaders: opts.traceHeaders,
	onUploadProgress: (progressEvent) => opts.onUploadProgress?.({
		delta: progressEvent.delta,
		loaded: progressEvent.loaded + start
	})
})), Micro.map(unsafeCoerce), Micro.map((uploadResponse) => ({
	name: file.name,
	size: file.size,
	key: presigned.key,
	lastModified: file.lastModified,
	serverData: uploadResponse.serverData,
	get url() {
		logDeprecationWarning("`file.url` is deprecated and will be removed in uploadthing v9. Use `file.ufsUrl` instead.");
		return uploadResponse.url;
	},
	get appUrl() {
		logDeprecationWarning("`file.appUrl` is deprecated and will be removed in uploadthing v9. Use `file.ufsUrl` instead.");
		return uploadResponse.appUrl;
	},
	ufsUrl: uploadResponse.ufsUrl,
	customId: presigned.customId,
	type: file.type,
	fileHash: uploadResponse.fileHash
})));
const uploadFilesInternal = (endpoint, opts) => {
	const traceHeaders = generateTraceHeaders();
	const reportEventToUT = createUTReporter({
		endpoint: String(endpoint),
		package: opts.package,
		url: opts.url,
		headers: opts.headers,
		traceHeaders
	});
	const totalSize = opts.files.reduce((acc, f) => acc + f.size, 0);
	let totalLoaded = 0;
	return Micro.flatMap(reportEventToUT("upload", {
		input: "input" in opts ? opts.input : null,
		files: opts.files.map((f) => ({
			name: f.name,
			size: f.size,
			type: f.type,
			lastModified: f.lastModified
		}))
	}), (presigneds) => Micro.forEach(presigneds, (presigned, i) => Micro.flatMap(Micro.sync(() => opts.onUploadBegin?.({ file: opts.files[i].name })), () => uploadFile(opts.files[i], presigned, {
		traceHeaders,
		onUploadProgress: (ev) => {
			totalLoaded += ev.delta;
			opts.onUploadProgress?.({
				file: opts.files[i],
				progress: ev.loaded / opts.files[i].size * 100,
				loaded: ev.loaded,
				delta: ev.delta,
				totalLoaded,
				totalProgress: totalLoaded / totalSize
			});
		}
	})), { concurrency: 6 }));
};

//#endregion
//#region src/client.ts
const version$1 = version;
/**
* Validate that a file is of a valid type given a route config
* @public
*/
const isValidFileType = (file, routeConfig) => Micro.runSync(matchFileType(file, objectKeys(routeConfig)).pipe(Micro.map((type) => file.type.includes(type)), Micro.orElseSucceed(() => false)));
/**
* Validate that a file is of a valid size given a route config
* @public
*/
const isValidFileSize = (file, routeConfig) => Micro.runSync(matchFileType(file, objectKeys(routeConfig)).pipe(Micro.flatMap((type) => fileSizeToBytes(routeConfig[type].maxFileSize)), Micro.map((maxFileSize) => file.size <= maxFileSize), Micro.orElseSucceed(() => false)));
/**
* Generate a typed uploader for a given FileRouter
* @public
*/
const genUploader = (initOpts) => {
	const routeRegistry = createIdentityProxy();
	const controllableUpload = async (slug, opts) => {
		const uploads = /* @__PURE__ */ new Map();
		const endpoint = typeof slug === "function" ? slug(routeRegistry) : slug;
		const traceHeaders = generateTraceHeaders();
		const utReporter = createUTReporter({
			endpoint: String(endpoint),
			package: initOpts?.package ?? "uploadthing/client",
			url: resolveMaybeUrlArg(initOpts?.url),
			headers: opts.headers,
			traceHeaders
		});
		const fetchFn = initOpts?.fetch ?? window.fetch;
		const presigneds = await Micro.runPromise(utReporter("upload", {
			input: "input" in opts ? opts.input : null,
			files: opts.files.map((f) => ({
				name: f.name,
				size: f.size,
				type: f.type,
				lastModified: f.lastModified
			}))
		}).pipe(Micro.provideService(FetchContext, fetchFn)));
		const totalSize = opts.files.reduce((acc, f) => acc + f.size, 0);
		let totalLoaded = 0;
		const uploadEffect = (file, presigned) => uploadFile(file, presigned, {
			traceHeaders,
			onUploadProgress: (progressEvent) => {
				totalLoaded += progressEvent.delta;
				opts.onUploadProgress?.({
					...progressEvent,
					file,
					progress: Math.round(progressEvent.loaded / file.size * 100),
					totalLoaded,
					totalProgress: Math.round(totalLoaded / totalSize * 100)
				});
			}
		}).pipe(Micro.provideService(FetchContext, fetchFn));
		for (const [i, p] of presigneds.entries()) {
			const file = opts.files[i];
			if (!file) continue;
			const deferred = createDeferred();
			uploads.set(file, {
				deferred,
				presigned: p
			});
			Micro.runPromiseExit(uploadEffect(file, p), { signal: deferred.ac.signal }).then((result) => {
				if (result._tag === "Success") return deferred.resolve(result.value);
				else if (result.cause._tag === "Interrupt") throw new UploadPausedError$1();
				throw Micro.causeSquash(result.cause);
			}).catch((err) => {
				if (err instanceof UploadPausedError$1) return;
				deferred.reject(err);
			});
		}
		/**
		* Pause an ongoing upload
		* @param file The file upload you want to pause. Can be omitted to pause all files
		*/
		const pauseUpload = (file) => {
			const files = Arr.ensure(file ?? opts.files);
			for (const file$1 of files) {
				const upload = uploads.get(file$1);
				if (!upload) return;
				if (upload.deferred.ac.signal.aborted) throw new UploadAbortedError$1();
				upload.deferred.ac.abort();
			}
		};
		/**
		* Resume a paused upload
		* @param file The file upload you want to resume. Can be omitted to resume all files
		*/
		const resumeUpload = (file) => {
			const files = Arr.ensure(file ?? opts.files);
			for (const file$1 of files) {
				const upload = uploads.get(file$1);
				if (!upload) throw "No upload found";
				upload.deferred.ac = new AbortController();
				Micro.runPromiseExit(uploadEffect(file$1, upload.presigned), { signal: upload.deferred.ac.signal }).then((result) => {
					if (result._tag === "Success") return upload.deferred.resolve(result.value);
					else if (result.cause._tag === "Interrupt") throw new UploadPausedError$1();
					throw Micro.causeSquash(result.cause);
				}).catch((err) => {
					if (err instanceof UploadPausedError$1) return;
					upload.deferred.reject(err);
				});
			}
		};
		/**
		* Wait for an upload to complete
		* @param file The file upload you want to wait for. Can be omitted to wait for all files
		*/
		const done = async (file) => {
			const promises = [];
			const files = Arr.ensure(file ?? opts.files);
			for (const file$1 of files) {
				const upload = uploads.get(file$1);
				if (!upload) throw "No upload found";
				promises.push(upload.deferred.promise);
			}
			const results = await Promise.all(promises);
			return file ? results[0] : results;
		};
		return {
			pauseUpload,
			resumeUpload,
			done
		};
	};
	/**
	* One step upload function that both requests presigned URLs
	* and then uploads the files to UploadThing
	*/
	const typedUploadFiles = (slug, opts) => {
		const endpoint = typeof slug === "function" ? slug(routeRegistry) : slug;
		const fetchFn = initOpts?.fetch ?? window.fetch;
		return uploadFilesInternal(endpoint, {
			...opts,
			skipPolling: {},
			url: resolveMaybeUrlArg(initOpts?.url),
			package: initOpts?.package ?? "uploadthing/client",
			input: opts.input
		}).pipe(Micro.provideService(FetchContext, fetchFn), (effect) => Micro.runPromiseExit(effect, opts.signal && { signal: opts.signal })).then((exit) => {
			if (exit._tag === "Success") return exit.value;
			else if (exit.cause._tag === "Interrupt") throw new UploadAbortedError$1();
			throw Micro.causeSquash(exit.cause);
		});
	};
	return {
		uploadFiles: typedUploadFiles,
		createUpload: controllableUpload,
		routeRegistry
	};
};

//#endregion
export { UploadAbortedError, UploadPausedError, allowedContentTextLabelGenerator, bytesToFileSize, genUploader, generateClientDropzoneAccept, generateMimeTypes, generatePermittedFileTypes, isValidFileSize, isValidFileType, version$1 as version };
//# sourceMappingURL=index.js.map