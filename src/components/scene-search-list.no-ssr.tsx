"use client";

import dynamic from "next/dynamic";

const SceneSearchList = dynamic(
  () => import("@/components/scene-search-list").then((m) => m.SceneSearchList),
  {
    ssr: false,
    loading: () => (
      <div className="py-8 text-center">
        <div className="text-muted-foreground text-lg">Loading...</div>
      </div>
    ),
  },
);

export default SceneSearchList;
