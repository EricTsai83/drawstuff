import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type StatefulButtonProps = React.ComponentProps<typeof Button> & {
  active?: boolean;
};

function StatefulButton({
  active = false,
  className,
  ...props
}: StatefulButtonProps) {
  return (
    <Button
      data-active={active ? "true" : undefined}
      aria-pressed={active}
      className={cn(
        active &&
          "shadow-inner border-primary bg-accent text-foreground hover:bg-accent hover:text-foreground dark:border-primary/60 dark:bg-input/50 dark:hover:bg-input/50",
        !active && "hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { StatefulButton };
