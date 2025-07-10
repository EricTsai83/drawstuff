"use client";

import { useState } from "react";
import { CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { THEME, useI18n } from "@excalidraw/excalidraw";
import type { Theme } from "@excalidraw/excalidraw/element/types";

interface CopyButtonProps {
  textToCopy: string;
  editorTheme: Theme;
}

export function CopyButton({ textToCopy, editorTheme }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("複製失敗:", err);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "cursor-pointer overflow-hidden rounded-full px-4 py-1.5 backdrop-blur transition-all duration-300",
        editorTheme === THEME.DARK ? "bg-[#474492] text-white" : "bg-[#c2bdfd]",
        {
          "bg-[#726cb4]": copied && editorTheme === THEME.DARK,
          "bg-[#b9b6fe]": copied && editorTheme === THEME.LIGHT,
        },
      )}
    >
      <span
        className={`pointer-events-none flex items-center gap-1 text-sm transition duration-300 ${
          copied ? "translate-y-[-100%] opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <CopyIcon className="size-3" />
        {t("labels.copy")}
      </span>
      <span
        className={`pointer-events-none absolute inset-0 flex items-center justify-center transition duration-300 ${
          copied ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
        }`}
      >
        <svg
          className="size-7 text-white"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline
            points="6 10 9 13 14 8"
            style={{
              strokeDasharray: 20,
              strokeDashoffset: copied ? 0 : 20,
              transition:
                "stroke-dashoffset 0.6s cubic-bezier(0.65, 0, 0.35, 1)",
            }}
          />
        </svg>
      </span>
    </button>
  );
}
