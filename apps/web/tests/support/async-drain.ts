/**
 * Draining queued async work in the collaboration tests.
 *
 * Every other kind of asynchrony these sessions have is injected and therefore
 * stated by the test: timers are manual, the network is flushed by hand, and a
 * snapshot store can hold its load open until a test releases it. Web Crypto is
 * the one exception. `crypto.subtle` settles on the platform's own schedule, off
 * the microtask queue, and how long that takes is a property of the machine —
 * under the full suite's parallel workers a single digest can take longer than
 * any fixed number of event-loop turns.
 *
 * So the turns are not counted, they are *watched*: the async `SubtleCrypto`
 * calls in flight are tracked, and a drain keeps yielding until none are left.
 * A fixed round count was the original approach and it made every snapshot
 * assertion a bet on scheduler speed — a lost bet looked exactly like a lost
 * write, because the cadence's `await collaborationSnapshotDigest(...)` had
 * simply not reached `store.save` yet.
 */

/** Marks an already-wrapped `crypto.subtle`, so setup cannot double-count. */
const TRACKING_MARKER = "__drawstuffPendingCryptoTracked";

/** Async `SubtleCrypto` methods; the sync ones cannot leave work in flight. */
const TRACKED_METHODS: readonly (keyof SubtleCrypto)[] = [
  "digest",
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "deriveBits",
  "deriveKey",
  "importKey",
  "exportKey",
  "generateKey",
  "wrapKey",
  "unwrapKey",
];

let inFlight = 0;

/** Async Web Crypto calls that have not settled yet. */
export const pendingCryptoCount = (): number => inFlight;

/**
 * Wraps `crypto.subtle` so `drainAsync` can tell "nothing is in flight" from
 * "the machine is slow today". Installed from `tests/setup.ts`, before any test
 * module runs.
 */
export function trackPendingCrypto(): void {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (!subtle || Reflect.get(subtle, TRACKING_MARKER) === true) return;
  for (const method of TRACKED_METHODS) {
    const original = subtle[method];
    if (typeof original !== "function") continue;
    const call = (...args: unknown[]): Promise<unknown> =>
      (original as (...callArgs: unknown[]) => Promise<unknown>).apply(
        subtle,
        args,
      );
    Object.defineProperty(subtle, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        inFlight += 1;
        return call(...args).finally(() => {
          inFlight -= 1;
        });
      },
    });
  }
  Object.defineProperty(subtle, TRACKING_MARKER, {
    configurable: true,
    value: true,
  });
}

/** Consecutive quiet rounds that count as drained; the original fixed count. */
const QUIET_ROUNDS = 4;
/** Bound on the wait, so a genuine stall fails the test instead of hanging. */
const MAX_ROUNDS = 500;

/**
 * Lets queued async work run without delivering any message: microtasks, plus
 * one macrotask per round because Web Crypto does not settle on the microtask
 * queue alone.
 *
 * Returns once `QUIET_ROUNDS` rounds have passed with no crypto call in flight,
 * which is the previous behaviour exactly whenever nothing is pending — and
 * keeps waiting when something is.
 */
export const drainAsync = async (): Promise<void> => {
  let quiet = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Checked after the macrotask yield: a settled digest has already run its
    // continuation by then, so a follow-on digest is counted in this round
    // rather than being mistaken for quiescence.
    quiet = pendingCryptoCount() === 0 ? quiet + 1 : 0;
    if (quiet >= QUIET_ROUNDS) return;
  }
  throw new Error("async work did not drain: Web Crypto never settled");
};
