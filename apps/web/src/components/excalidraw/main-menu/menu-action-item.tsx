"use client";

import type { ReactNode } from "react";

type MenuActionItemProps = {
  icon: ReactNode;
  label: string;
  onActivate: () => void;
  detail?: string;
  disabled?: boolean;
  busy?: boolean;
};

/**
 * Shared shape for a Drawstuff product action inside the native main menu.
 *
 * Upstream's `MainMenu.Item` renders a `<button>` that closes the menu through
 * its own `onSelect` plumbing; these actions open a dialog rendered outside the
 * menu instead, so they keep upstream's item classes on a plain element and
 * close the menu themselves.
 */
export function MenuActionItem({
  icon,
  label,
  onActivate,
  detail,
  disabled = false,
  busy = false,
}: MenuActionItemProps) {
  return (
    <button
      type="button"
      className="dropdown-menu-item dropdown-menu-item-base"
      onClick={onActivate}
      disabled={disabled}
      aria-busy={busy}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {detail && (
        <span className="text-muted-foreground max-w-28 truncate text-xs">
          {detail}
        </span>
      )}
    </button>
  );
}
