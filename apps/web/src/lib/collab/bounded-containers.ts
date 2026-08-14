/**
 * Generic bounded building blocks for the asset transfer path.
 *
 * An asset is three orders of magnitude larger than a scene delta, so every
 * step of its transfer has a ceiling rather than a best effort. These are the
 * ceilings themselves — id bookkeeping with FIFO eviction, a store-wide
 * transfer budget, and a body reader that enforces a declared length — kept
 * free of asset semantics so each can be tested on its own.
 */

/**
 * Insertion-ordered map with FIFO eviction; the oldest entry is always first.
 *
 * `onEvict` exists because a bounded map is only safe if everything derived from
 * it is dropped with it: an id whose retry state was evicted while something else
 * still listed it would look like an id with no deadline, which reads as "due
 * now".
 */
export const createBoundedIdMap = <T>(
  limit: number,
  onEvict?: (id: string) => void,
) => {
  const entries = new Map<string, T>();
  return {
    get: (id: string): T | undefined => entries.get(id),
    has: (id: string): boolean => entries.has(id),
    set(id: string, value: T): void {
      if (!entries.has(id)) {
        while (entries.size >= limit) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
          onEvict?.(oldest.value);
        }
      }
      entries.set(id, value);
    },
    delete(id: string): void {
      entries.delete(id);
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
};

export type BoundedIdMap<T> = ReturnType<typeof createBoundedIdMap<T>>;

export type BoundedIdSet = {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): void;
  readonly size: number;
};

export const createBoundedIdSet = (limit: number): BoundedIdSet => {
  const ids = createBoundedIdMap<true>(limit);
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.set(id, true);
    },
    delete: (id) => {
      ids.delete(id);
    },
    get size() {
      return ids.size;
    },
  };
};

/**
 * Store-wide transfer budget.
 *
 * A slot is either held by a running transfer or handed directly to the next
 * waiter, so the count can neither drift nor be exceeded by callers that overlap.
 */
export const createTransferGate = (limit: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < limit) active += 1;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
};

export type TransferGate = ReturnType<typeof createTransferGate>;

/**
 * Reads a response body without ever holding more than `maxBytes`.
 *
 * `arrayBuffer()` would decide the size after materializing it, which is the one
 * thing a bound has to prevent — the record's declared length is what this trusts,
 * and a body that exceeds it is cancelled mid-stream.
 */
export const readBoundedBody = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const body = response.body;
  if (!body) {
    // No streaming body (a non-streaming fetch implementation): the declared
    // length is still enforced, just after the fact.
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength <= maxBytes ? buffer : null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
