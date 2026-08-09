"use client";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";

export function SceneCardSkeleton() {
  return (
    <Card className="min-h-80 gap-3 overflow-hidden pt-0">
      <CardHeader className="p-0">
        <div className="relative aspect-video min-h-32 overflow-hidden">
          <div
            className="bg-muted/80 absolute inset-0 animate-pulse"
            aria-hidden="true"
          />
          <div className="absolute bottom-0 left-0 flex gap-2">
            <div className="bg-muted/90 h-6 w-32 animate-pulse rounded-tr-[10px]" />
          </div>
          <div className="absolute top-3 right-3 flex gap-2">
            <div className="bg-muted/90 size-11 animate-pulse rounded-full" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-muted/80 h-5 w-3/4 animate-pulse rounded" />
        </div>
        <div className="flex flex-col gap-1" aria-hidden="true">
          <div className="bg-muted/70 h-4 w-full animate-pulse rounded" />
          <div className="bg-muted/60 h-4 w-2/3 animate-pulse rounded" />
        </div>
      </CardContent>
      <CardFooter className="mt-auto">
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <div className="bg-muted/70 h-3 w-3 animate-pulse rounded-full" />
          <div className="bg-muted/70 h-4 w-32 animate-pulse rounded" />
        </div>
      </CardFooter>
    </Card>
  );
}
