"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

type OverlayModalProps = {
  children: React.ReactNode;
  centerOverlay?: boolean;
  centerContent?: boolean;
  overlayClassName?: string;
  contentClassName?: string;
  closeDelayMs?: number;
  onClose?: () => void;
};

export function OverlayModal({
  children,
  centerOverlay = false,
  centerContent = false,
  overlayClassName,
  contentClassName,
  closeDelayMs = 150,
  onClose,
}: OverlayModalProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(true);

  const handleBackdropClick = () => {
    setIsOpen(false);
    setTimeout(() => {
      if (onClose) onClose();
      else router.back();
    }, closeDelayMs);
  };

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 overflow-y-auto bg-black/50",
        centerOverlay && "flex items-center justify-center",
        overlayClassName,
      )}
      onClick={handleBackdropClick}
    >
      <div
        className={cn(
          "bg-background mx-auto",
          centerContent && "flex items-center justify-center",
          contentClassName,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
