import { SceneCardSkeleton } from "./scene-card-skeleton";

export function DashboardListFallback() {
  return (
    <div className="w-full space-y-5 p-6 pt-0">
      <div className="relative pt-12 pb-16">
        <div className="bg-muted mx-auto h-8 w-64 rounded" />
        <div className="bg-muted absolute right-0 bottom-0 h-10 w-64 rounded" />
      </div>

      <div className="relative">
        <div className="bg-muted absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform rounded" />
        <div className="bg-muted h-10 w-full rounded" />
      </div>

      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <div className="bg-muted h-6 w-48 rounded" />
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="animate-pulse">
              <SceneCardSkeleton />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <div className="bg-muted h-6 w-32 rounded" />
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="animate-pulse">
              <SceneCardSkeleton />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
