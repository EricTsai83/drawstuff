"use client";

import "@excalidraw/excalidraw/index.css";

import {
  CaptureUpdateAction,
  DefaultSidebar,
  defaultLang,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  Footer,
  getVisibleSceneBounds,
  languages,
  MainMenu,
  MIME_TYPES,
  parseLibraryTokensFromUrl,
  restore,
  restoreLibraryItems,
  Stats,
  THEME,
  useI18n,
  useHandleLibrary,
  UserIdleState,
  WelcomeScreen,
  zoomToFitBounds,
} from "@excalidraw/excalidraw";
import { createElement, type ReactElement, useEffect, useRef } from "react";

import type {
  ExcalidrawCanvasProps,
  ExcalidrawImperativeAPI,
  ExcalidrawLibraryPersistenceAdapter,
} from "./types.ts";

export const OFFICIAL_EXCALIDRAW_LIBRARY_ORIGIN =
  "https://libraries.excalidraw.com";
export const MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export function isOfficialExcalidrawLibraryUrl(libraryUrl: string): boolean {
  try {
    const url = new URL(libraryUrl);
    return (
      url.protocol === "https:" &&
      url.origin === OFFICIAL_EXCALIDRAW_LIBRARY_ORIGIN &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443")
    );
  } catch {
    return false;
  }
}

type LibraryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchOfficialExcalidrawLibrary(
  libraryUrl: string,
  fetchLibrary: LibraryFetch = fetch,
): Promise<Blob> {
  const decodedUrl = decodeURIComponent(libraryUrl);
  if (!isOfficialExcalidrawLibraryUrl(decodedUrl)) {
    throw new Error("Invalid or disallowed Excalidraw library URL.");
  }

  const response = await fetchLibrary(decodedUrl, {
    credentials: "omit",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    throw new Error(`Excalidraw library download failed (${response.status}).`);
  }
  if (!isOfficialExcalidrawLibraryUrl(response.url || decodedUrl)) {
    throw new Error("Excalidraw library redirected to a disallowed origin.");
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES
  ) {
    throw new Error("Excalidraw library download is too large.");
  }

  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES) {
      throw new Error("Excalidraw library download is too large.");
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_EXCALIDRAW_LIBRARY_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error("Excalidraw library download is too large.");
      }
      chunks.push(value.slice().buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return new Blob(chunks, {
    type: response.headers.get("content-type") ?? undefined,
  });
}

type UseExcalidrawLibraryOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  adapter?: ExcalidrawLibraryPersistenceAdapter;
  fetchLibrary?: LibraryFetch;
  resetOnMount?: boolean;
  onReady?: () => void;
  onInstallError?: (error: Error) => void;
};

/**
 * Audited host wrapper around upstream Library persistence and install flow.
 * The official hook remains responsible for restore/merge/save semantics. We
 * intercept only the catalog download so redirects and response bytes can be
 * bounded before the Blob reaches upstream's public `updateLibrary()` API.
 */
export function useExcalidrawLibrary(
  options: UseExcalidrawLibraryOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const { excalidrawAPI } = optionsRef.current;
    if (!excalidrawAPI) return;
    let active = true;

    const removeLibraryTokens = (): void => {
      const url = new URL(window.location.href);
      if (url.hash.includes("addLibrary")) {
        const hash = new URLSearchParams(url.hash.slice(1));
        hash.delete("addLibrary");
        hash.delete("token");
        url.hash = hash.toString();
      } else {
        url.searchParams.delete("addLibrary");
      }
      window.history.replaceState({}, "", url);
    };

    type LibraryTokens = NonNullable<
      ReturnType<typeof parseLibraryTokensFromUrl>
    >;
    const installFromUrl = async (tokens: LibraryTokens): Promise<void> => {
      try {
        const blob = await fetchOfficialExcalidrawLibrary(
          tokens.libraryUrl,
          optionsRef.current.fetchLibrary,
        );
        if (!active) return;
        await excalidrawAPI.updateLibrary({
          libraryItems: blob,
          prompt: tokens.idToken !== excalidrawAPI.id,
          merge: true,
          defaultStatus: "published",
          openLibraryMenu: true,
        });
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("Library install failed.");
        if (active) {
          excalidrawAPI.updateScene({
            appState: { errorMessage: error.message },
          });
          optionsRef.current.onInstallError?.(error);
        }
      }
    };

    const initialize = async (): Promise<void> => {
      // Scrub synchronously. Upstream registers its own effect after this one;
      // leaving the token until the first await would let its unbounded fetch
      // race us on initial mount.
      const tokens = parseLibraryTokensFromUrl();
      if (tokens) removeLibraryTokens();
      if (optionsRef.current.resetOnMount !== false) {
        await excalidrawAPI.updateLibrary({ libraryItems: [], merge: false });
      }
      if (!active) return;
      optionsRef.current.onReady?.();
      if (tokens) await installFromUrl(tokens);
    };

    const onHashChange = (event: HashChangeEvent): void => {
      const tokens = parseLibraryTokensFromUrl();
      if (!tokens) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.history.replaceState({}, "", event.oldURL);
      void installFromUrl(tokens);
    };

    // Registered before upstream's listener (the hook below), so unsafe URLs
    // never reach its unbounded fetch path.
    window.addEventListener("hashchange", onHashChange);
    void initialize();
    return () => {
      active = false;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [options.excalidrawAPI]);

  useHandleLibrary(
    options.adapter
      ? {
          excalidrawAPI: options.excalidrawAPI,
          adapter: options.adapter,
          // Install tokens are handled by the bounded effect above.
          validateLibraryUrl: () => false,
        }
      : {
          excalidrawAPI: options.excalidrawAPI,
          validateLibraryUrl: () => false,
        },
  );
}

export function ExcalidrawCanvas(
  props: ExcalidrawCanvasProps,
): ReactElement<ExcalidrawCanvasProps> {
  return createElement(Excalidraw, props);
}

/**
 * Options of the upstream SVG export, derived from the function itself so the
 * passthrough can never drift from the engine's own signature.
 */
export type ExcalidrawSvgExportOptions = Parameters<typeof exportToSvg>[0];

export {
  CaptureUpdateAction as EXCALIDRAW_CAPTURE_UPDATE_ACTION,
  DefaultSidebar as ExcalidrawDefaultSidebar,
  defaultLang as DEFAULT_EXCALIDRAW_LANGUAGE,
  exportToBlob as exportCanvasToBlob,
  exportToSvg as exportSceneToSvg,
  Footer as ExcalidrawFooter,
  // Follow mode: measure the local viewport in scene coordinates, and fit the
  // local viewport to a followed peer's bounds. Both are upstream public API.
  getVisibleSceneBounds,
  zoomToFitBounds,
  languages as EXCALIDRAW_LANGUAGES,
  MainMenu as ExcalidrawMainMenu,
  MIME_TYPES as EXCALIDRAW_MIME_TYPES,
  restoreLibraryItems as restoreExcalidrawLibraryItems,
  restore as restoreScene,
  Stats as ExcalidrawStats,
  THEME as EXCALIDRAW_THEME,
  useI18n as useExcalidrawI18n,
  UserIdleState as EXCALIDRAW_USER_IDLE_STATE,
  WelcomeScreen as ExcalidrawWelcomeScreen,
};
