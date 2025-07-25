"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function SignInOverlayModal({
  children,
}: {
  children: React.ReactNode;
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
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-background border-border mx-auto flex w-full max-w-sm flex-col items-center justify-center rounded-lg border px-4 py-8"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
