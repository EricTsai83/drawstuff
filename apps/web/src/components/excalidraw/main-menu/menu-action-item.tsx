"use client";

import type { ReactNode } from "react";

type MenuActionItemProps = {
  icon: ReactNode;
  label: string;
  onActivate: () => void;
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
}: MenuActionItemProps) {
  return (
    <div
      className="dropdown-menu-item dropdown-menu-item-base"
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        onActivate();
      }}
    >
      {icon}
      {label}
    </div>
  );
}
