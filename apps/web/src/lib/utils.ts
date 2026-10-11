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

const UPLOADTHING_MB_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512] as const;
type UploadThingFileSize = `${(typeof UPLOADTHING_MB_STEPS)[number]}MB` | "1GB";

/**
 * UploadThing only accepts power-of-two size limits, so this returns the
 * smallest one that still admits `bytes`. It can be looser than the real cap;
 * enforce the exact byte limit separately.
 */
export function getMaxFileSizeString(bytes: number): UploadThingFileSize {
  const mib = bytes / 2 ** 20;
  const step = UPLOADTHING_MB_STEPS.find((candidate) => candidate >= mib);
  return step === undefined ? "1GB" : `${step}MB`;
}
