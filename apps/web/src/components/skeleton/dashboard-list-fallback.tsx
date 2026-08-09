import { SceneGridSkeleton } from "./scene-grid-skeleton";

export function DashboardListFallback({
  showHeading = true,
}: {
  showHeading?: boolean;
}) {
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-5 overflow-x-clip p-4 pt-0 sm:p-6 sm:pt-0">
      <div className="flex flex-col gap-4 pt-6 pb-2 sm:pt-10 sm:pb-4">
        {showHeading && (
          <h1 className="text-center text-2xl font-semibold lg:text-3xl">
            <span className="bg-muted inline-block h-[1em] w-56 rounded align-middle sm:w-64 md:w-80 lg:w-96" />
          </h1>
        )}
        <div className="ml-auto w-full sm:w-64">
          <div className="bg-muted h-10 w-full rounded" />
        </div>
      </div>

      <div className="relative">
        <div className="bg-muted absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform rounded" />
        <div className="bg-muted h-10 w-full rounded" />
      </div>

      <section className="flex flex-col gap-4">
        <div className="border-t border-gray-200 pt-4">
          <div className="bg-muted h-6 w-48 rounded" />
        </div>
        <SceneGridSkeleton count={5} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="border-t border-gray-200 pt-4">
          <div className="bg-muted h-6 w-32 rounded" />
        </div>
        <SceneGridSkeleton count={5} />
      </section>
    </div>
  );
}
