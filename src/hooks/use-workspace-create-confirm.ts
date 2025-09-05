"use client";

import { useCallback, useMemo, useState } from "react";

export type ConfirmDialogOptions = {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  onConfirm?: () => void | Promise<void>;
};

export type UseWorkspaceCreateConfirmReturn = {
  workspaceCreateConfirmOpen: boolean;
  setWorkspaceCreateConfirmOpen: (open: boolean) => void;
  workspaceCreateConfirmLoading: boolean;
  workspaceCreateConfirmOptions: ConfirmDialogOptions;
  showWorkspaceCreateConfirm: (options: ConfirmDialogOptions) => void;
};

const defaultOptions: ConfirmDialogOptions = {
  title: "Confirm",
  description: undefined,
  confirmText: "Confirm",
  cancelText: "Cancel",
  isDestructive: false,
  onConfirm: undefined,
};

export function useWorkspaceCreateConfirm(): UseWorkspaceCreateConfirmReturn {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ConfirmDialogOptions>(defaultOptions);

  const show = useCallback((opts: ConfirmDialogOptions) => {
    const userOnConfirm = opts.onConfirm;
    const wrapped: ConfirmDialogOptions = {
      ...defaultOptions,
      ...opts,
      onConfirm: async () => {
        try {
          setLoading(true);
          await Promise.resolve(userOnConfirm?.());
        } finally {
          setLoading(false);
          setOpen(false);
        }
      },
    };
    setOptions((prev) => ({ ...prev, ...wrapped }));
    setOpen(true);
  }, []);

  return useMemo(
    () => ({
      workspaceCreateConfirmOpen: open,
      setWorkspaceCreateConfirmOpen: setOpen,
      workspaceCreateConfirmLoading: loading,
      workspaceCreateConfirmOptions: options,
      showWorkspaceCreateConfirm: show,
    }),
    [open, loading, options, show],
  );
}
