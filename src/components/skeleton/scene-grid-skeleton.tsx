"use client";

import { SceneCardSkeleton } from "./scene-card-skeleton";

export function SceneGridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <SceneCardSkeleton />
        </div>
      ))}
    </div>
  );
}
