"use client";

import dynamic from "next/dynamic";

import { installExcalidrawAssetPath } from "@/config/excalidraw-asset-path";

// 在 editor chunk（含 @excalidraw/excalidraw）載入前把字型資產指向自家
// origin，否則 upstream 會 fallback 到 esm.sh（threat model T16 的出口收斂）。
installExcalidrawAssetPath();

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
