"use client";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";

/** Scene-name context for compact native main-menu presentations. */
export function SceneTitle({ sceneName }: { sceneName: string }) {
  return (
    <div
      className="mx-2 mb-2 flex w-full min-w-0 items-center justify-center gap-2 px-2 pt-1 text-center text-xl font-bold"
      data-testid="main-menu-scene-title"
    >
      <div className="size-4 shrink-0">
        <DrawstuffLogo className="size-4" />
      </div>
      <span className="block max-w-full truncate">{sceneName}</span>
    </div>
  );
}
