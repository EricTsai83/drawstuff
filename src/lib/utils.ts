import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 定義可解析 Promise 的介面
interface ResolvablePromise<T> extends Promise<T> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export const resolvablePromise = <T>(): ResolvablePromise<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  // 使用 Object.assign 來添加方法，避免 any 類型
  return Object.assign(promise, {
    resolve,
    reject,
  }) as ResolvablePromise<T>;
};

export const debounce = <T extends unknown[]>(
  fn: (...args: T) => void,
  timeout: number,
) => {
  let handle = 0;
  let lastArgs: T | null = null;
  const ret = (...args: T) => {
    lastArgs = args;
    clearTimeout(handle);
    handle = window.setTimeout(() => {
      lastArgs = null;
      fn(...args);
    }, timeout);
  };
  ret.flush = () => {
    clearTimeout(handle);
    if (lastArgs) {
      const _lastArgs = lastArgs;
      lastArgs = null;
      fn(..._lastArgs);
    }
  };
  ret.cancel = () => {
    lastArgs = null;
    clearTimeout(handle);
  };
  return ret;
};

// https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
// Browsers can store up to 5 MiB of local storage, and 5 MiB of session storage per origin.
type Unit = { value: number; symbol: string };

export function nFormatter(num: number, digits: number): string {
  const units: Unit[] = [
    { value: 1, symbol: "B" },
    { value: 2 ** 10, symbol: "KiB" },
    { value: 2 ** 20, symbol: "MiB" },
    { value: 2 ** 30, symbol: "GiB" },
    { value: 2 ** 40, symbol: "TiB" },
  ];
  const rx = /\.0+$|(\.[0-9]*[1-9])0+$/;
  let idx: number;
  for (idx = units.length - 1; idx > 0; idx--) {
    // @ts-expect-error - index is guaranteed to be valid after loop initialization
    if (num >= units[idx].value) break;
  }
  // @ts-expect-error - index is guaranteed to be valid after loop initialization
  const formatted = (num / units[idx].value).toFixed(digits).replace(rx, "$1");
  // @ts-expect-error - index is guaranteed to be valid after loop initialization
  return `${formatted}${units[idx].symbol}`;
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
