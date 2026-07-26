"use client";

import dynamic from "next/dynamic";

const WhiteboardEditor = dynamic(
  async () =>
    (await import("@/components/whiteboard/whiteboard-editor")).default,
  {
    ssr: false,
  },
);

export default function WhiteboardClientWrapper() {
  return <WhiteboardEditor />;
}
