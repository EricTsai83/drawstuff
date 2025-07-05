"use client";

import dynamic from "next/dynamic";

const ExcalidrawWrapper = dynamic(
  async () =>
    (await import("@/components/excalidraw/excalidraw-wrapper")).default,
  {
    ssr: false,
  },
);

export default function ExcalidrawClientWrapper() {
  return <ExcalidrawWrapper />;
}
