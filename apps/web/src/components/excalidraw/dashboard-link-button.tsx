import Link from "next/link";
import { PanelsTopLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KeyboardEvent, MouseEvent } from "react";

type DashboardLinkButtonProps = {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

function handleKeyDown(event: KeyboardEvent<HTMLAnchorElement>): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  event.currentTarget.click();
}

export function DashboardLinkButton({
  ariaLabel,
  className,
  onClick,
}: DashboardLinkButtonProps): React.ReactNode {
  return (
    <Link
      href="/dashboard"
      aria-label={ariaLabel}
      className={cn("focus-visible:outline-none", className)}
      tabIndex={0}
      role="button"
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <PanelsTopLeft
        className={cn(
          "flex h-9 w-9 cursor-pointer items-center justify-center rounded-full p-2",
          "bg-[#e9ecef] text-[#5c5c5c] hover:bg-[#f1f0ff]",
          "dark:bg-[#232329] dark:text-[#b8b8b8] dark:hover:bg-[#2d2d38]",
        )}
        aria-hidden="true"
      />
    </Link>
  );
}
