"use client";

import { useEffect, useState } from "react";

/**
 * True for `ms` after `key` takes a new non-null value, then false until the
 * next new key. For confirmations that should flash and settle — a save's check
 * mark — when the underlying state ("saved") persists indefinitely.
 */
export function useTransientKey(key: string | null, ms: number): boolean {
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => setSettledKey(key), ms);
    return () => window.clearTimeout(timer);
  }, [key, ms]);
  return key !== null && settledKey !== key;
}
