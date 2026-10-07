import { expect, it, vi } from "vitest";
import { withCollaborationRequestDeadline } from "@/lib/collab/request-deadline";

it("a lost HTTP response times out and aborts the request", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const pending = withCollaborationRequestDeadline((requestSignal) => {
      signal = requestSignal;
      return new Promise<never>(() => undefined);
    });
    const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
