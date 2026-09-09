import { parsePublishedSvgArtifact } from "@/lib/svg-artifact";
import type {
  PublishedSceneSource,
  PublishedSceneTheme,
} from "@/components/excalidraw/published-scene-viewer";

export type PublishedArtifactUrls = {
  lightUrl: string;
  darkUrl: string;
};

/**
 * The normal path of `/p/[slug]`: one immutable, content-addressed SVG per
 * theme, rendered by the author's browser at save/publish time. A visit costs
 * one download; a theme switch costs one more. Downloaded text is cached per
 * theme so toggling back re-parses instead of re-fetching (the object is
 * immutable and the browser cache would answer anyway; this skips the trip).
 */
export function createArtifactSceneSource(
  urls: PublishedArtifactUrls,
): PublishedSceneSource {
  // Only downloaded text is cached, never a pending request: React Strict
  // Mode replays the load effect, aborting the first request, and a second
  // load that picked up that aborted promise would fail with it and leave
  // the visitor on the loading screen.
  const texts = new Map<PublishedSceneTheme, string>();

  const fetchText = async (theme: PublishedSceneTheme, signal: AbortSignal) => {
    const cached = texts.get(theme);
    if (cached !== undefined) return cached;
    const url = theme === "dark" ? urls.darkUrl : urls.lightUrl;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(
        `Published artifact request failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    texts.set(theme, text);
    return text;
  };

  return {
    key: `${urls.lightUrl}\n${urls.darkUrl}`,
    load: async (theme, signal) =>
      // A fresh element per load: the previous one is still mounted on the
      // stage while the next variant is fetched.
      parsePublishedSvgArtifact(await fetchText(theme, signal)),
  };
}
