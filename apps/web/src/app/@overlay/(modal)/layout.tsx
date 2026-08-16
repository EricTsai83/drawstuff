import { RouteOverlay } from "@/components/route-overlay";

export default function ModalOverlayLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <RouteOverlay>{children}</RouteOverlay>;
}
