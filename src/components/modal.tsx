"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type RouteModalProps = {
  children: React.ReactNode;
  title?: string;
};

export function RouteModal({ children, title }: RouteModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Auto-open when component mounts (for intercepted routes)
  useEffect(() => {
    setOpen(true);
  }, []);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setOpen(false);

      // Small delay to allow exit animation before navigating back
      setTimeout(() => {
        router.back();
      }, 150);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
