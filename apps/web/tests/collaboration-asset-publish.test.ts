// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { RoomId } from "@drawstuff/collaboration/protocol";
import type {
  BinaryFileData,
  DataURL,
  FileId,
} from "@drawstuff/excalidraw-adapter/types";

import { createAssetPublisher } from "@/lib/collab/asset-publish";
import { AssetUploadPendingError } from "@/lib/collab/asset-upload";
import {
  createBoundedIdSet,
  createTransferGate,
} from "@/lib/collab/bounded-containers";

const file: BinaryFileData = {
  id: "a".repeat(40) as FileId,
  dataURL: "data:image/png;base64,AAECAwQFBgcICQoLDA0ODw" as DataURL,
  mimeType: "image/png",
  created: 1,
  lastRetrieved: 1,
};

describe("asset publisher", () => {
  it("gives up on an upload whose receipt stays pending, with backoff", async () => {
    let clock = 0;
    const upload = vi.fn(() =>
      Promise.reject(new AssetUploadPendingError(new Error("gateway down"))),
    );
    const abandoned = createBoundedIdSet(10);
    const abandon = vi.fn((id: string) => abandoned.add(id));
    const publisher = createAssetPublisher({
      upload,
      roomId: "room-1" as RoomId,
      signal: new AbortController().signal,
      isDestroyed: () => false,
      now: () => clock,
      scheduleTimeout: () => () => undefined,
      retryDelayMs: (attempts) => 1_000 * attempts,
      maxTrackedIds: 10,
      transfers: createTransferGate(4),
      resolved: createBoundedIdSet(10),
      abandoned,
      available: createBoundedIdSet(10),
      abandon,
      flushUnavailable: () => undefined,
    });

    // A publish inside the backoff window is skipped, not counted.
    await publisher.publish([file]);
    await publisher.publish([file]);
    expect(upload).toHaveBeenCalledTimes(1);

    for (let round = 0; round < 20 && !abandoned.has(file.id); round += 1) {
      clock += 60_000;
      await publisher.publish([file]);
    }
    expect(upload).toHaveBeenCalledTimes(10);
    expect(abandon).toHaveBeenCalledWith(file.id);

    clock += 60_000;
    await publisher.publish([file]);
    expect(upload).toHaveBeenCalledTimes(10);
  });
});
