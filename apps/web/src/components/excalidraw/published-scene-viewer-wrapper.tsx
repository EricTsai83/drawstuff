"use client";

import { useMemo } from "react";

import {
  createArtifactSceneSource,
  type PublishedArtifactUrls,
} from "@/components/excalidraw/published-scene-artifact-source";
import { PublishedSceneViewer } from "@/components/excalidraw/published-scene-viewer";

type PublishedSceneViewerWrapperProps = {
  artifacts: PublishedArtifactUrls;
  sceneName: string;
  authorName?: string;
};

/**
 * Binds the page's artifact URLs to a scene source for the viewer shell. The
 * source identity follows the URLs, so a republished scene (new content-hashed
 * objects) re-fits the viewport while a re-render with the same props does not.
 */
export default function PublishedSceneViewerWrapper({
  artifacts,
  sceneName,
  authorName,
}: PublishedSceneViewerWrapperProps) {
  const source = useMemo(
    () => createArtifactSceneSource(artifacts),
    [artifacts],
  );
  return (
    <PublishedSceneViewer
      source={source}
      sceneName={sceneName}
      authorName={authorName}
    />
  );
}
