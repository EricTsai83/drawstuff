"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function DashboardOverlayModal({
  children,
  centerContent = false,
}: {
  children: React.ReactNode;
  centerContent?: boolean;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setIsOpen(true);
  }, []);

  const handleBackdropClick = () => {
    setIsOpen(false);
    setTimeout(() => {
      router.back();
    }, 150);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 pt-6"
      onClick={handleBackdropClick}
    >
      <div
        className={cn(
          "bg-background mx-auto min-h-full w-4/5 rounded-none border-0",
          centerContent && "flex items-center justify-center",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
