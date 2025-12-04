const require_chunk = require('../dist/chunk-CUT6urMc.cjs');
require('../dist/package-CKF1Vr61.cjs');
require('../dist/deprecations-DPGpmqha.cjs');
require('../dist/shared-schemas-CG9VaBtT.cjs');
const require_upload_builder = require('../dist/upload-builder-RrqQb3by.cjs');
const require_to_web_request = require('../dist/to-web-request-BQtxSXgE.cjs');
const effect_Effect = require_chunk.__toESM(require("effect/Effect"));

//#region src/next-legacy.ts
const createUploadthing = (opts) => require_upload_builder.createBuilder(opts);
const createRouteHandler = (opts) => {
	const handler = require_upload_builder.makeAdapterHandler((req, res) => effect_Effect.succeed({
		req,
		res
	}), (req) => require_to_web_request.toWebRequest(req), opts, "nextjs-pages");
	return async (req, res) => {
		const response = await handler(req, res);
		res.status(response.status);
		for (const [name, value] of response.headers) res.setHeader(name, value);
		return res.json(await response.json());
	};
};

//#endregion
exports.UTFiles = require_upload_builder.UTFiles;
exports.createRouteHandler = createRouteHandler;
exports.createUploadthing = createUploadthing;
exports.experimental_UTRegion = require_upload_builder.UTRegion;