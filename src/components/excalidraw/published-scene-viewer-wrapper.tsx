"use client";

import dynamic from "next/dynamic";

const PublishedSceneViewer = dynamic(
  () =>
    import("./published-scene-viewer").then(
      (mod) => mod.PublishedSceneViewer,
    ),
  {
    ssr: false,
  },
);

type PublishedSceneViewerWrapperProps = {
  sceneData: string;
  fileRecords: Array<{
    url: string;
  }>;
  sceneName: string;
  sceneDescription: string;
  authorName?: string;
  updatedAt: string;
};

export default function PublishedSceneViewerWrapper(
  props: PublishedSceneViewerWrapperProps,
) {
  return <PublishedSceneViewer {...props} />;
}
