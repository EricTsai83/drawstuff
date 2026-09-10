import { parsePublishedSvgArtifact } from "@/lib/svg-artifact";
import type { PublishedSceneSource } from "@/components/excalidraw/published-scene-viewer";

export type PublishedArtifactLocation = {
  url: string;
};

/**
 * The normal path of `/p/[slug]`: one immutable, content-addressed SVG
 * rendered by the author's browser at save/publish time, serving both themes.
 * A visit costs one download; a theme switch costs none, because the file
 * carries the dark render's differences as overrides the viewer writes onto
 * the parsed DOM.
 */
export function createArtifactSceneSource(
  location: PublishedArtifactLocation,
): PublishedSceneSource {
  // Only downloaded text is cached, never a pending request: React Strict
  // Mode replays the load effect, aborting the first request, and a second
  // load that picked up that aborted promise would fail with it and leave
  // the visitor on the loading screen.
  let text: string | undefined;

  const fetchText = async (signal: AbortSignal) => {
    if (text !== undefined) return text;
    const response = await fetch(location.url, { signal });
    if (!response.ok) {
      throw new Error(
        `Published artifact request failed with status ${response.status}`,
      );
    }
    text = await response.text();
    return text;
  };

  return {
    key: location.url,
    load: async (signal: AbortSignal) =>
      parsePublishedSvgArtifact(await fetchText(signal)),
  };
}
