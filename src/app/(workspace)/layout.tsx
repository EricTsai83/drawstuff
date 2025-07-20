import ExcalidrawClientSideWrapper from "@/components/excalidraw/excalidraw-client-wrapper";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ExcalidrawClientSideWrapper />
      {children}
    </>
  );
}
