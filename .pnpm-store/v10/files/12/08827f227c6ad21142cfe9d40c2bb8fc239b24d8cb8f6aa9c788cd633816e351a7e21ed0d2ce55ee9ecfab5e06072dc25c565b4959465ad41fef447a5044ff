import "../dist/package-DpScpvTA.js";
import "../dist/deprecations-pLmw6Ytd.js";
import "../dist/shared-schemas-BmG5ARoX.js";
import { AdapterArguments, UTFiles, UTRegion, configProvider, createBuilder, createRequestHandler } from "../dist/upload-builder-BlFOAnsv.js";
import * as Effect from "effect/Effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Layer from "effect/Layer";

//#region src/effect-platform.ts
const createUploadthing = (opts) => createBuilder(opts);
const createRouteHandler = (opts) => {
	const router = Effect.runSync(createRequestHandler(opts, "effect-platform"));
	return HttpRouter.provideServiceEffect(router, AdapterArguments, Effect.map(HttpServerRequest.HttpServerRequest, (serverRequest) => ({ req: serverRequest }))).pipe(Effect.provide(Layer.setConfigProvider(configProvider(opts.config))));
};

//#endregion
export { UTFiles, createRouteHandler, createUploadthing, UTRegion as experimental_UTRegion };
//# sourceMappingURL=index.js.map