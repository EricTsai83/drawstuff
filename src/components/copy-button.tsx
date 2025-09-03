"use client";

import { useState } from "react";
import { CopyIcon } from "lucide-react";
import { useAppI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { copyTextToSystemClipboard } from "@/lib/utils";

type CopyButtonProps = {
  textToCopy: string;
};

export function CopyButton({ textToCopy }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const { t } = useAppI18n();

  const handleCopy = async () => {
    await copyTextToSystemClipboard(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      type="button"
      onClick={handleCopy}
      size="sm"
      className="relative overflow-hidden"
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
          className="size-7"
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
    </Button>
  );
}
