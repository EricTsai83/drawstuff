"use client";

import Link from "next/link";
import { Bluesky, Github, Blog } from "@/components/icons";

const SOCIAL_LINKS = [
  { href: "https://github.com/EricTsai83/drawstuff", Icon: Github },
  { href: "https://bsky.app/profile/ericts.com", Icon: Bluesky },
  { href: "https://ericts.com", Icon: Blog },
] as const;

export function SocialLinksItem() {
  return (
    <div className="flex flex-row gap-2">
      {SOCIAL_LINKS.map(({ href, Icon }) => (
        <Link
          key={href}
          href={href}
          target="_blank"
          rel="noopener"
          className="dropdown-menu-item dropdown-menu-item-base"
        >
          <div className="flex w-full justify-center">
            <Icon />
          </div>
        </Link>
      ))}
    </div>
  );
}
