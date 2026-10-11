import type { DoLogger } from "./logger.ts";

/**
 * The official runtime retries a failed alarm handler a bounded number of
 * times (currently documented as up to 6 attempts) with exponential backoff.
 * On the last retry the handler re-arms a backstop alarm before rethrowing,
 * so pending deadlines do not die with the last retry — but only a bounded
 * number of times: consecutive backstops back off from 1 minute to 1 hour
 * and stop after `MAX_BACKSTOPS` (about a day), logging `alarm.given_up`.
 * Any later request that commits work re-arms the alarm normally.
 */
const ALARM_FINAL_RETRY_COUNT = 5;
const BACKSTOP_BASE_MS = 60_000;
const BACKSTOP_MAX_DELAY_MS = 60 * 60_000;
const MAX_BACKSTOPS = 30;
const BACKSTOPS_KEY = "alarm-backstops";

export async function runAlarmWithBackstop(
  storage: DurableObjectStorage,
  alarmInfo: AlarmInvocationInfo | undefined,
  log: DoLogger,
  pass: () => Promise<void>,
): Promise<void> {
  try {
    await pass();
    // Reads only: a released Object must not be recreated by a write here.
    if ((await storage.get(BACKSTOPS_KEY)) !== undefined)
      await storage.delete(BACKSTOPS_KEY);
  } catch (error) {
    if ((alarmInfo?.retryCount ?? 0) >= ALARM_FINAL_RETRY_COUNT) {
      const backstops = (await storage.get<number>(BACKSTOPS_KEY)) ?? 0;
      if (backstops >= MAX_BACKSTOPS) {
        await storage.delete(BACKSTOPS_KEY);
        log.error("alarm.given_up");
      } else {
        await storage.put(BACKSTOPS_KEY, backstops + 1);
        await storage.setAlarm(
          Date.now() +
            Math.min(BACKSTOP_MAX_DELAY_MS, BACKSTOP_BASE_MS * 2 ** backstops),
        );
      }
    }
    throw error;
  }
}
