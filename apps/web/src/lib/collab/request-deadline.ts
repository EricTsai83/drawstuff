/** A lost HTTP response must end in unconfirmed state, not an eternal spinner. */
export async function withCollaborationRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Collaboration persistence request timed out"));
    }, 15_000);
  });
  try {
    return await Promise.race([request(signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
