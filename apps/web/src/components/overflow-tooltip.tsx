"use client";

import { cloneElement, useCallback, useState } from "react";
import type { MouseEvent, ReactElement } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

type MouseEventsProps = {
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
};

type OverflowTooltipProps = {
  children: ReactElement<MouseEventsProps>;
  content: React.ReactNode;
  delayDuration?: number;
  sideOffset?: number;
  contentClassName?: string;
};

export function OverflowTooltip({
  children,
  content,
  delayDuration = 0,
  sideOffset = 0,
  contentClassName,
}: OverflowTooltipProps) {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  const handleMouseEnter = useCallback((event: MouseEvent<HTMLElement>) => {
    const targetElement = event.currentTarget;
    const isOverflowed = targetElement.scrollWidth > targetElement.clientWidth;
    setIsTooltipVisible(isOverflowed);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsTooltipVisible(false);
  }, []);

  const enhancedChild: ReactElement<MouseEventsProps> = cloneElement(children, {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      children.props?.onMouseEnter?.(event);
      handleMouseEnter(event);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      children.props?.onMouseLeave?.(event);
      handleMouseLeave();
    },
  });

  if (!isTooltipVisible) {
    return enhancedChild;
  }

  return (
    <Tooltip>
      <TooltipTrigger delay={delayDuration} render={enhancedChild} />
      <TooltipContent sideOffset={sideOffset} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export default OverflowTooltip;
