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

interface ProjectItem {
  id: string;
  name: string;
  description: string;
  image: string;
  lastUpdated: Date;
  category: string;
}

interface ProjectCardProps {
  item: ProjectItem;
}

export function ProjectCard({ item }: ProjectCardProps) {
  const timeAgo = formatDistanceToNow(item.lastUpdated, { addSuffix: true });

  return (
    <Card className="group cursor-pointer gap-2 overflow-hidden pt-0 transition-shadow duration-200 hover:shadow-lg">
      <CardHeader className="p-0">
        <div className="relative aspect-video overflow-hidden">
          <Image
            src={item.image || "/placeholder.svg"}
            alt={item.name}
            fill
            className="object-cover transition-transform duration-200 group-hover:scale-105"
          />
          <div className="absolute top-3 right-3">
            <Badge
              variant="secondary"
              className="bg-background/80 backdrop-blur-sm"
            >
              <Tag className="mr-1 h-3 w-3" />
              {item.category}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <h3 className="group-hover:text-primary line-clamp-1 text-lg font-semibold transition-colors">
          {item.name}
        </h3>
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
