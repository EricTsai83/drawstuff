"use client";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";

/**
 * Scene name header, shown only on the narrow layout where the editor's
 * top-left scene-name trigger is hidden.
 */
export function SceneTitle({ sceneName }: { sceneName: string }) {
  return (
    <div className="mx-2 mb-2 flex w-full items-center justify-center gap-2 truncate px-2 pt-1 text-center text-xl font-bold min-[728px]:hidden">
      <div className="h-4 w-4">
        <DrawstuffLogo className="h-4 w-4" />
      </div>
      <span className="block max-w-full truncate">{sceneName}</span>
    </div>
  );
}
