import { describe, expect, it, vi } from "vitest";

import { runAlarmWithBackstop } from "../src/alarm-backstop.ts";
import type { DoLogger } from "../src/logger.ts";

function fakeStorage() {
  const values = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage = {
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(values.delete(key)),
    setAlarm: (at: number) => {
      alarms.push(at);
      return Promise.resolve();
    },
  } as unknown as DurableObjectStorage;
  return { storage, values, alarms };
}

const logger = () => {
  const error = vi.fn();
  return { log: { info: vi.fn(), warn: vi.fn(), error } as DoLogger, error };
};
const failing = () => Promise.reject(new Error("broken"));
const retry = (retryCount: number) =>
  ({ retryCount, isRetry: true }) as unknown as AlarmInvocationInfo;
const finalRetry = retry(5);

describe("alarm backstop", () => {
  it("re-arms only on the runtime's final retry, backing off to an hour", async () => {
    const { storage, alarms } = fakeStorage();
    const { log } = logger();
    await expect(
      runAlarmWithBackstop(storage, retry(1), log, failing),
    ).rejects.toThrow("broken");
    expect(alarms).toEqual([]);

    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const before = Date.now();
      await expect(
        runAlarmWithBackstop(storage, finalRetry, log, failing),
      ).rejects.toThrow("broken");
      delays.push(Math.round((alarms.at(-1)! - before) / 60_000));
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it("gives up after a bounded number of backstops and resets on success", async () => {
    const { storage, values, alarms } = fakeStorage();
    const { log, error } = logger();
    values.set("alarm-backstops", 30);
    await expect(
      runAlarmWithBackstop(storage, finalRetry, log, failing),
    ).rejects.toThrow("broken");
    expect(alarms).toEqual([]);
    expect(error).toHaveBeenCalledWith("alarm.given_up");

    values.set("alarm-backstops", 3);
    await runAlarmWithBackstop(storage, finalRetry, log, () =>
      Promise.resolve(),
    );
    expect(values.has("alarm-backstops")).toBe(false);
  });
});
