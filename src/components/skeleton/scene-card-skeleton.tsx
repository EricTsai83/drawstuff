"use client";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";

export function SceneCardSkeleton() {
  return (
    <Card className="h-[252px] overflow-hidden pt-0">
      <CardHeader className="p-0">
        <div className="bg-muted relative h-[150px]" />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="bg-muted h-4 w-3/5 rounded" />
          <div className="flex flex-wrap gap-1">
            <div className="bg-muted h-4 w-12 rounded" />
            <div className="bg-muted h-4 w-16 rounded" />
            <div className="bg-muted h-4 w-10 rounded" />
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <div className="bg-muted h-2 w-24 rounded" />
      </CardFooter>
    </Card>
  );
}
