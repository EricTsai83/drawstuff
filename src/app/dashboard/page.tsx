import { DashboardContent } from "@/components/dashboard-content";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  return <DashboardContent searchParams={searchParams} />;
}
