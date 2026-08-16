"use client";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { OverflowTooltip } from "@/components/overflow-tooltip";
import { cn } from "@/lib/utils";

/** Scene-name context for compact native main-menu presentations. */
export function SceneTitle({
  sceneName,
  className,
}: {
  sceneName: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2 w-full min-w-0 overflow-hidden px-2 pt-1 text-center text-xl font-bold [contain:inline-size] min-[730px]:text-base min-[730px]:font-semibold",
        className,
      )}
      data-testid="main-menu-scene-title"
    >
      <div className="inline-flex max-w-full min-w-0 items-center justify-center gap-2 align-middle">
        <div className="size-4 shrink-0">
          <DrawstuffLogo className="size-4" />
        </div>
        <OverflowTooltip
          content={sceneName}
          delayDuration={400}
          variant="secondary"
          sideOffset={6}
          contentClassName="max-w-[min(20rem,calc(100vw-2rem))] break-words"
        >
          <span className="min-w-0 truncate">{sceneName}</span>
        </OverflowTooltip>
      </div>
    </div>
  );
}
