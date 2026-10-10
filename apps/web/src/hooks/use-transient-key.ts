"use client";

import { useEffect, useState } from "react";

/**
 * True for `ms` after `key` takes a new non-null value, then false until the
 * next new key. For confirmations that should flash and settle — a save's check
 * mark — when the underlying state ("saved") persists indefinitely.
 *
 * The first key seen in each `scope` (e.g. a room) counts as already shown:
 * the state that was there on arrival is not news, so entering a room that is
 * already saved flashes nothing.
 */
export function useTransientKey(
  key: string | null,
  ms: number,
  scope: string | null,
): boolean {
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [arrival, setArrival] = useState<{
    scope: string | null;
    key: string;
  } | null>(null);
  // Derived from the previous render (React's "adjust state during render"):
  // re-renders before commit, so the arrival key never flashes.
  if (key !== null && (arrival === null || arrival.scope !== scope))
    setArrival({ scope, key });
  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => setSettledKey(key), ms);
    return () => window.clearTimeout(timer);
  }, [key, ms]);
  const isArrival =
    arrival !== null && arrival.scope === scope && arrival.key === key;
  return key !== null && !isArrival && settledKey !== key;
}
