import { FileRouter, RouteHandlerConfig, UTFiles, UTRegion, UnsetMarker, UploadBuilder } from "../dist/types-V6mH1dCh.cjs";
import { CreateBuilderOptions } from "../dist/upload-builder-Dplyfqsy.cjs";
import * as _uploadthing_shared25 from "@uploadthing/shared";
import { Json } from "@uploadthing/shared";
import * as _effect_platform_HttpBody36 from "@effect/platform/HttpBody";
import * as Effect from "effect/Effect";
import * as effect_Cause38 from "effect/Cause";
import * as _effect_platform_HttpServerResponse33 from "@effect/platform/HttpServerResponse";
import * as _effect_platform_HttpServerError34 from "@effect/platform/HttpServerError";
import * as effect_ConfigError37 from "effect/ConfigError";
import * as _effect_platform_HttpClient39 from "@effect/platform/HttpClient";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";

//#region src/effect-platform.d.ts
type AdapterArgs = {
  req: HttpServerRequest.HttpServerRequest;
};
declare const createUploadthing: <TErrorShape extends Json>(opts?: CreateBuilderOptions<TErrorShape>) => <TRouteOptions extends _uploadthing_shared25.RouteOptions>(input: _uploadthing_shared25.FileRouterInputConfig, config?: TRouteOptions | undefined) => UploadBuilder<{
  _routeOptions: TRouteOptions;
  _input: {
    in: UnsetMarker;
    out: UnsetMarker;
  };
  _metadata: UnsetMarker;
  _adapterFnArgs: AdapterArgs;
  _errorShape: TErrorShape;
  _errorFn: UnsetMarker;
  _output: UnsetMarker;
}>;
declare const createRouteHandler: <TRouter extends FileRouter>(opts: {
  router: TRouter;
  /**
   * @remarks In order to obey by Effect conventions, we have omitted the `config.fetch` and `config.logLevel` options.
   * You can provide these layers on your own if you need to.
   *
   * @example
   * ```ts
   * import { Effect, Layer, Logger, LogLevel } from "effect";
   * import { HttpClient } from "@effect/platform";
      * // Set logLevel
   * Logger.withMinimumLogLevel(LogLevel.Debug)
   *
   * // Override fetch implementation
   * Layer.succeed(
   *   HttpClient.Fetch,
   *   myFetchImplementation,
   * );
   * ```
   */
  config?: Omit<RouteHandlerConfig, "fetch" | "logLevel">;
}) => Effect.Effect<_effect_platform_HttpServerResponse33.HttpServerResponse, _effect_platform_HttpServerError34.RequestError | _effect_platform_HttpServerError34.RouteNotFound | _effect_platform_HttpBody36.HttpBodyError | effect_ConfigError37.ConfigError | effect_Cause38.NoSuchElementException, HttpServerRequest.HttpServerRequest | _effect_platform_HttpClient39.HttpClient>;
//#endregion
//# sourceMappingURL=effect-platform.d.ts.map
export { FileRouter, UTFiles, createRouteHandler, createUploadthing, UTRegion as experimental_UTRegion };
//# sourceMappingURL=index.d.cts.map