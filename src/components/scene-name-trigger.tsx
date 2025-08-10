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
        "z-10 cursor-pointer overflow-hidden text-lg leading-5 font-medium text-ellipsis text-black select-none focus:outline-none dark:text-white",
        //mobile
        "fixed bottom-6 left-1/2 z-10 w-56 -translate-x-1/2 whitespace-nowrap",
        //desktop
        "min-[728px]:pointer-events-none min-[728px]:invisible min-[728px]:top-8 min-[728px]:bottom-auto min-[728px]:left-16 min-[728px]:w-36 min-[728px]:translate-x-0 min-[728px]:-translate-y-1/2 min-[728px]:whitespace-normal min-[1072px]:pointer-events-auto min-[1072px]:visible min-[1072px]:line-clamp-2",
      )}
      title="Click to rename scene"
      role="button"
      tabIndex={0}
      {...props}
    >
      {sceneName}
    </div>
  );
});

SceneNameTrigger.displayName = "SceneNameTrigger";
