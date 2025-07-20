"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type DashboardOverlayModalProps = {
  children: React.ReactNode;
};

export function DashboardOverlayModal({
  children,
}: DashboardOverlayModalProps) {
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
        className="bg-background mx-auto min-h-full w-4/5 rounded-none border-0"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
