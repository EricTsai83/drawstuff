"use client";

import dynamic from "next/dynamic";
import type { WhiteboardRolloutDecision } from "@/features/whiteboard";

const ExcalidrawEditor = dynamic(
  async () =>
    (await import("@/components/excalidraw/excalidraw-editor")).default,
  {
    ssr: false,
  },
);

export default function ExcalidrawClientSideWrapper({
  rollout,
}: {
  readonly rollout: WhiteboardRolloutDecision;
}) {
  return <ExcalidrawEditor rollout={rollout} />;
}
