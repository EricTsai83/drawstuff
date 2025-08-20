"use client";

import { formatDistanceToNow } from "date-fns";
import { Clock, Tag } from "lucide-react";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SceneItem } from "@/lib/types";

export function ProjectCard({ item }: { item: SceneItem }) {
  const timeAgo = formatDistanceToNow(item.updatedAt, { addSuffix: true });

  return (
    <Card className="cursor-pointer gap-2 overflow-hidden pt-0 transition-shadow duration-200 hover:shadow-lg">
      <CardHeader className="p-0">
        <div className="relative aspect-video overflow-hidden">
          <Image
            src={item.thumbnail ?? "/placeholder.svg"}
            alt={item.name}
            fill
            className="object-cover transition-transform duration-200"
          />
          <div className="absolute top-3 right-3">
            <Badge
              variant="secondary"
              className="bg-background/80 backdrop-blur-sm"
            >
              <Tag className="mr-1 h-3 w-3" />
              {item.projectName ?? ""}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <h3 className="line-clamp-1 text-lg font-semibold">{item.name}</h3>
        <div className="mb-2 flex flex-wrap gap-1">
          {item.categories.map((cat) => (
            <Badge key={cat} variant="secondary" className="text-xs">
              {cat}
            </Badge>
          ))}
        </div>
        <p className="text-muted-foreground line-clamp-2 text-sm">
          {item.description}
        </p>
      </CardContent>

      <CardFooter>
        <div className="text-muted-foreground flex items-center text-xs">
          <Clock className="mr-1 h-3 w-3" />
          <span>Updated {timeAgo}</span>
        </div>
      </CardFooter>
    </Card>
  );
}
