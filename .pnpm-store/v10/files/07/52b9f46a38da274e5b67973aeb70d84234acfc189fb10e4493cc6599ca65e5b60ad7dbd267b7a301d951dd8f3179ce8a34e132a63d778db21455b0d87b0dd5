const require_chunk = require('../dist/chunk-CUT6urMc.cjs');
require('../dist/package-CKF1Vr61.cjs');
require('../dist/deprecations-DPGpmqha.cjs');
require('../dist/shared-schemas-CG9VaBtT.cjs');
const require_upload_builder = require('../dist/upload-builder-RrqQb3by.cjs');
const effect_Effect = require_chunk.__toESM(require("effect/Effect"));
const __effect_platform_HttpRouter = require_chunk.__toESM(require("@effect/platform/HttpRouter"));
const __effect_platform_HttpServerRequest = require_chunk.__toESM(require("@effect/platform/HttpServerRequest"));
const effect_Layer = require_chunk.__toESM(require("effect/Layer"));

//#region src/effect-platform.ts
const createUploadthing = (opts) => require_upload_builder.createBuilder(opts);
const createRouteHandler = (opts) => {
	const router = effect_Effect.runSync(require_upload_builder.createRequestHandler(opts, "effect-platform"));
	return __effect_platform_HttpRouter.provideServiceEffect(router, require_upload_builder.AdapterArguments, effect_Effect.map(__effect_platform_HttpServerRequest.HttpServerRequest, (serverRequest) => ({ req: serverRequest }))).pipe(effect_Effect.provide(effect_Layer.setConfigProvider(require_upload_builder.configProvider(opts.config))));
};

//#endregion
exports.UTFiles = require_upload_builder.UTFiles;
exports.createRouteHandler = createRouteHandler;
exports.createUploadthing = createUploadthing;
exports.experimental_UTRegion = require_upload_builder.UTRegion;