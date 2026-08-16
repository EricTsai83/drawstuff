import DashboardContent from "@/components/modal-pages/dashboard-content";

export default async function DashboardOverlayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 標題由 RouteOverlay 的 DialogTitle 提供，內容不再重複一個 h1。
  return (
    <DashboardContent searchParams={await searchParams} showHeading={false} />
  );
}
