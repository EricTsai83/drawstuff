import { MIME_TYPES } from "@/config/app-constants";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
// Browsers can store up to 5 MiB of local storage, and 5 MiB of session storage per origin.
type Unit = { value: number; symbol: string };

const BASE_UNIT: Unit = { value: 1, symbol: "B" };
const SCALED_UNITS: readonly Unit[] = [
  { value: 2 ** 10, symbol: "KiB" },
  { value: 2 ** 20, symbol: "MiB" },
  { value: 2 ** 30, symbol: "GiB" },
  { value: 2 ** 40, symbol: "TiB" },
];

export function nFormatter(num: number, digits: number): string {
  const rx = /\.0+$|(\.[0-9]*[1-9])0+$/;
  // Largest unit the value reaches; values below 1 KiB stay in bytes.
  let unit = BASE_UNIT;
  for (const candidate of SCALED_UNITS) {
    if (num >= candidate.value) unit = candidate;
  }
  const formatted = (num / unit.value).toFixed(digits).replace(rx, "$1");
  return `${formatted}${unit.symbol}`;
}

// Convert bytes to MB string for UploadThing
export const getMaxFileSizeString = (
  bytes: number,
):
  | "1MB"
  | "2MB"
  | "4MB"
  | "8MB"
  | "16MB"
  | "32MB"
  | "64MB"
  | "128MB"
  | "256MB"
  | "512MB"
  | "1GB" => {
  const mb = Math.round(bytes / (1024 * 1024));

  // Map to supported UploadThing values
  if (mb <= 1) return "1MB";
  if (mb <= 2) return "2MB";
  if (mb <= 4) return "4MB";
  if (mb <= 8) return "8MB";
  if (mb <= 16) return "16MB";
  if (mb <= 32) return "32MB";
  if (mb <= 64) return "64MB";
  if (mb <= 128) return "128MB";
  if (mb <= 256) return "256MB";
  if (mb <= 512) return "512MB";
  return "1GB"; // Default fallback
};

const probablySupportsClipboardWriteText =
  typeof window !== "undefined" &&
  "clipboard" in navigator &&
  "writeText" in navigator.clipboard;

export const copyTextToSystemClipboard = async (
  text: string | null,
  clipboardEvent?: ClipboardEvent | null,
) => {
  // (1) first try using Async Clipboard API
  if (probablySupportsClipboardWriteText) {
    try {
      // NOTE: doesn't work on FF on non-HTTPS domains, or when document
      // not focused
      await navigator.clipboard.writeText(text ?? "");
      return;
    } catch (error) {
      console.error(error);
    }
  }

  // (2) if fails and we have access to ClipboardEvent, use plain old setData()
  try {
    if (clipboardEvent) {
      clipboardEvent.clipboardData?.setData(MIME_TYPES.text, text ?? "");
      if (clipboardEvent.clipboardData?.getData(MIME_TYPES.text) !== text) {
        throw new Error("Failed to setData on clipboardEvent");
      }
      return;
    }
  } catch (error) {
    console.error(error);
  }

  // (3) if that fails, use document.execCommand
  if (!copyTextViaExecCommand(text)) {
    throw new Error("Error copying to clipboard.");
  }
};

// adapted from https://github.com/zenorocha/clipboard.js/blob/ce79f170aa655c408b6aab33c9472e8e4fa52e19/src/clipboard-action.js#L48
const copyTextViaExecCommand = (text: string | null) => {
  // execCommand doesn't allow copying empty strings, so if we're
  // clearing clipboard using this API, we must copy at least an empty char
  text ??= " ";

  const isRTL = document.documentElement.getAttribute("dir") === "rtl";

  const textarea = document.createElement("textarea");

  textarea.style.border = "0";
  textarea.style.padding = "0";
  textarea.style.margin = "0";
  textarea.style.position = "absolute";
  textarea.style[isRTL ? "right" : "left"] = "-9999px";
  const yPosition = window.pageYOffset || document.documentElement.scrollTop;
  textarea.style.top = `${yPosition}px`;
  // Prevent zooming on iOS
  textarea.style.fontSize = "12pt";

  textarea.setAttribute("readonly", "");
  textarea.value = text;

  document.body.appendChild(textarea);

  let success = false;

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    success = document.execCommand("copy");
  } catch (error) {
    console.error(error);
  }

  textarea.remove();

  return success;
};

// 解析分享連結使用的 URL hash：#json=<id>,<key>
const SHARED_SCENE_HASH_RE = /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;
type ParsedSharedSceneHash = { id: string; key: string };

export function parseSharedSceneHash(
  hash?: string,
): ParsedSharedSceneHash | null {
  if (hash === undefined) {
    if (typeof window === "undefined") return null;
    hash = window.location.hash;
  }
  const match = SHARED_SCENE_HASH_RE.exec(hash);
  if (!match?.[1] || !match?.[2]) return null;
  return { id: match[1], key: match[2] };
}
