import { type ReactNode } from "react";

export type OverwriteConfirmRequest = {
  title: string;
  description: ReactNode;
  actionLabel: string;
};

type OverwriteConfirmHandler = (
  request: OverwriteConfirmRequest,
) => Promise<boolean>;

let overwriteConfirmHandler: OverwriteConfirmHandler | null = null;
const pendingOverwriteConfirmRequests: Array<{
  request: OverwriteConfirmRequest;
  resolve: (value: boolean) => void;
}> = [];

export function setOverwriteConfirmHandler(
  handler: OverwriteConfirmHandler | null,
): void {
  overwriteConfirmHandler = handler;
  if (!handler) return;
  // flush pending requests if any
  while (pendingOverwriteConfirmRequests.length > 0) {
    const { request, resolve } = pendingOverwriteConfirmRequests.shift()!;
    handler(request)
      .then(resolve)
      .catch(() => resolve(false));
  }
}

export async function openConfirmModal(request: OverwriteConfirmRequest) {
  return new Promise<boolean>((resolve) => {
    if (overwriteConfirmHandler) {
      overwriteConfirmHandler(request)
        .then(resolve)
        .catch(() => resolve(false));
      return;
    }
    // if handler not yet registered (e.g., early during initial render), queue it
    pendingOverwriteConfirmRequests.push({ request, resolve });
  });
}
