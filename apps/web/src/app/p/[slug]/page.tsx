import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PublishedSceneViewerWrapper from "@/components/excalidraw/published-scene-viewer-wrapper";
import { api } from "@/trpc/server";

export const dynamic = "force-dynamic";

type PublishedScenePageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateMetadata({
  params,
}: PublishedScenePageProps): Promise<Metadata> {
  const { slug } = await params;
  const scene = await api.scene.getPublishedSceneBySlug({ slug });

  if (!scene) {
    return { title: "Not Found" };
  }

  const title = `${scene.name} — drawstuff`;
  const description =
    scene.description || `A published scene by ${scene.authorName ?? "drawstuff"}`;

  return {
    title,
    description,
    openGraph: {
      title: scene.name,
      description,
      type: "article",
      ...(scene.thumbnailUrl ? { images: [{ url: scene.thumbnailUrl }] } : {}),
      ...(scene.publishedAt ? { publishedTime: scene.publishedAt.toISOString() } : {}),
      modifiedTime: scene.updatedAt.toISOString(),
    },
    twitter: {
      card: scene.thumbnailUrl ? "summary_large_image" : "summary",
      title: scene.name,
      description,
      ...(scene.thumbnailUrl ? { images: [scene.thumbnailUrl] } : {}),
    },
  };
}

export default async function PublishedScenePage({
  params,
}: PublishedScenePageProps) {
  const { slug } = await params;
  const scene = await api.scene.getPublishedSceneBySlug({ slug });

  if (!scene) {
    notFound();
  }

  return (
    <main className="h-dvh">
      <PublishedSceneViewerWrapper
        sceneData={scene.sceneData}
        fileRecords={scene.files}
        sceneName={scene.name}
        sceneDescription={scene.description}
        authorName={scene.authorName}
        updatedAt={scene.updatedAt.toISOString()}
      />
    </main>
  );
}
