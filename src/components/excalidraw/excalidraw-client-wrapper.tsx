"use client";

import dynamic from "next/dynamic";

const ExcalidrawEditor = dynamic(
  async () =>
    (await import("@/components/excalidraw/excalidraw-editor")).default,
  {
    ssr: false,
  },
);

export default function ExcalidrawClientSideWrapper() {
  return <ExcalidrawEditor />;
}
