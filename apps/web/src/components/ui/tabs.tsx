"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex min-w-0 flex-col gap-8", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "border-border relative flex min-w-0 items-center gap-6 border-b",
        className,
      )}
      {...props}
    />
  );
}

/** An underlined tab: the active one is marked by weight and an accent rule, not color alone. */
function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 data-[active]:text-foreground data-[active]:border-primary -mb-px inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 border-transparent px-0.5 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] data-[active]:font-semibold",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("flex min-w-0 flex-col gap-5 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTab, TabsPanel };
