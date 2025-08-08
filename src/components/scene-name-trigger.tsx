import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const SceneNameTrigger = forwardRef<
  HTMLDivElement,
  { sceneName: string } & React.HTMLAttributes<HTMLDivElement>
>(({ sceneName, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "fixed top-5 left-20 z-10 w-40 text-lg font-medium",
        "overflow-hidden leading-5 text-ellipsis text-black lg:line-clamp-2",
        "cursor-pointer select-none focus:outline-none dark:text-white",
      )}
      title="雙擊重新命名"
      role="button"
      tabIndex={0}
      {...props}
    >
      {sceneName}
    </div>
  );
});

SceneNameTrigger.displayName = "SceneNameTrigger";
