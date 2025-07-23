import ExcalidrawClientSideWrapper from "@/components/excalidraw/excalidraw-client-wrapper";

export default function WorkspaceLayout({
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
