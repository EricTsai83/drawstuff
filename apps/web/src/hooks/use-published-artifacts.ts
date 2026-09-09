"use client";

import { useCallback } from "react";

import { useUploadThing } from "@/lib/uploadthing";
import { readSingleUploadedFile } from "@/lib/uploadthing-result";
import type { RenderedPublishedArtifacts } from "@/lib/render-published-artifacts";
import type { RouterInputs } from "@/trpc/react";

export type PublishedArtifactsInput =
  RouterInputs["scene"]["setPublishedArtifacts"]["artifacts"];

type Variant = "light" | "dark";

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Uploads a rendered light/dark pair through `publishedArtifactUploader` and
 * shapes the result as the `artifacts` input of `scene.publish` and
 * `scene.setPublishedArtifacts`. The upload handler only reserves the keys;
 * whichever mutation the caller invokes next claims them.
 */
export function usePublishedArtifactUpload() {
  // Only `startUpload` is destructured: it is the one stable identity on the
  // object `useUploadThing` returns.
  const { startUpload } = useUploadThing("publishedArtifactUploader");

  return useCallback(
    async (params: {
      sceneId: string;
      rendered: RenderedPublishedArtifacts;
      /** Scene revision the pair was rendered from. */
      revision: number;
    }): Promise<PublishedArtifactsInput> => {
      const uploadVariant = async (variant: Variant) => {
        const blob = params.rendered[variant];
        const contentHash = await sha256Hex(blob);
        const file = new File([blob], `${variant}-${contentHash}.svg`, {
          type: blob.type,
        });
        const result = await startUpload([file], {
          sceneId: params.sceneId,
          variant,
          contentHash,
        });
        return readSingleUploadedFile(result, `Published ${variant} artifact`);
      };
      const [light, dark] = await Promise.all([
        uploadVariant("light"),
        uploadVariant("dark"),
      ]);
      return {
        light,
        dark,
        engineVersion: params.rendered.engineVersion,
        revision: params.revision,
      };
    },
    [startUpload],
  );
}
