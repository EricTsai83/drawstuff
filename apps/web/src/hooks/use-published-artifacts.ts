"use client";

import { useCallback } from "react";

import { useUploadThing } from "@/lib/uploadthing";
import { readSingleUploadedFile } from "@/lib/uploadthing-result";
import type { RenderedPublishedArtifacts } from "@/lib/render-published-artifacts";
import type { RouterInputs } from "@/trpc/react";
import { sha256Hex } from "@/lib/sha256";

export type PublishedArtifactsInput =
  RouterInputs["scene"]["setPublishedArtifacts"]["artifacts"];

/**
 * Uploads the rendered artifact through `publishedArtifactUploader` and
 * shapes the result as the `artifacts` input of `scene.publish` and
 * `scene.setPublishedArtifacts`. The upload handler only reserves the key;
 * whichever mutation the caller invokes next claims it.
 */
export function usePublishedArtifactUpload() {
  // Only `startUpload` is destructured: it is the one stable identity on the
  // object `useUploadThing` returns.
  const { startUpload } = useUploadThing("publishedArtifactUploader");

  return useCallback(
    async (params: {
      sceneId: string;
      rendered: RenderedPublishedArtifacts;
      /** Scene revision the artifact was rendered from. */
      revision: number;
    }): Promise<PublishedArtifactsInput> => {
      const blob = params.rendered.artifact;
      const contentHash = await sha256Hex(blob);
      const file = new File([blob], `scene-${contentHash}.svg`, {
        type: blob.type,
      });
      const result = await startUpload([file], {
        sceneId: params.sceneId,
        contentHash,
      });
      return {
        artifact: readSingleUploadedFile(result, "Published artifact"),
        engineVersion: params.rendered.engineVersion,
        revision: params.revision,
      };
    },
    [startUpload],
  );
}
