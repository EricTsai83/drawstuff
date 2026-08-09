"use client";

import { SceneCardSkeleton } from "./scene-card-skeleton";
import { SCENE_GRID_CLASS_NAME } from "@/components/scene-grid-layout";

export function SceneGridSkeleton({ count }: { count: number }) {
  return (
    <div className={SCENE_GRID_CLASS_NAME}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <SceneCardSkeleton />
        </div>
      ))}
    </div>
  );
}
