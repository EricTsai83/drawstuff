import { getBaseUrl } from "@/lib/base-url";

export function getPublishedScenePath(slug: string): string {
  return `/p/${slug}`;
}

export function getPublishedSceneUrl(slug: string): string {
  return new URL(getPublishedScenePath(slug), getBaseUrl()).toString();
}
