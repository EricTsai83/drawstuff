"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type DashboardModalProps = {
  children: React.ReactNode;
};

export function DashboardModal({ children }: DashboardModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Auto-open when component mounts (for intercepted routes)
  useEffect(() => {
    setOpen(true);
  }, []);

  const handleBackdropClick = () => {
    setOpen(false);
    setTimeout(() => {
      router.back();
    }, 150);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-background mx-auto min-h-full w-4/5 translate-y-4 rounded-none border-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 pb-0">
          <h2 className="text-lg font-semibold">Dashboard</h2>
        </div>
        <div className="p-6 pt-0">{children}</div>
      </div>
    </div>
  );
}
