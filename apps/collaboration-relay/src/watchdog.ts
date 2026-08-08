import type { RelayLogger } from "./logger.ts";

/**
 * Max-memory restart threshold: 1 GiB, the value SLO §4.1 approved as the
 * counterpart of upstream's `max_memory_restart`. Changing it requires a new
 * approved revision of `docs/performance/collaboration-slo-capacity.md`, not an
 * edit here — which is also why it is not an environment variable.
 */
export const MAX_RELAY_RSS_BYTES = 1_073_741_824;

/**
 * RSS sampling cadence. Memory growth that matters here is a leak or a pile-up
 * of stuck consumers, both of which build over minutes; 10 s resolves them
 * while costing one `memoryUsage` call per sample.
 */
const SAMPLE_INTERVAL_MS = 10_000;

/**
 * Watches the process RSS and reports — once — when it crosses the SLO §4.1
 * restart threshold in the deployment envelope.
 *
 * The watchdog only observes and notifies: acting on the breach is
 * `onExceeded`'s job, and the caller wires it to the same graceful drain a
 * SIGTERM takes. That routing is the entire point — upstream's
 * `max_memory_restart` hard-kills the process, which turns a memory problem
 * into a simultaneous disconnect of every member of every room, while a drain
 * lets each client rejoin the restarted process with a retryable close code.
 */
export function createMaxMemoryWatchdog(options: {
  logger: RelayLogger;
  /** Called at most once, after the breach has been logged. */
  onExceeded: () => void;
  maxRssBytes?: number;
  sampleIntervalMs?: number;
  /** RSS source; tests inject one, production reads the process. */
  rss?: () => number;
}): { stop(): void } {
  const maxRssBytes = options.maxRssBytes ?? MAX_RELAY_RSS_BYTES;
  const rss = options.rss ?? ((): number => process.memoryUsage.rss());

  const timer = setInterval(() => {
    const rssBytes = rss();
    if (rssBytes <= maxRssBytes) return;
    // Stop before notifying: `onExceeded` starts a drain that outlives this
    // tick, and a second firing would report the same breach twice.
    stop();
    options.logger.error("relay.memory_limit_exceeded", {
      rssBytes,
      maxRssBytes,
    });
    options.onExceeded();
  }, options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
  // The watchdog must never be what keeps the process alive.
  timer.unref();

  const stop = (): void => clearInterval(timer);
  return { stop };
}
