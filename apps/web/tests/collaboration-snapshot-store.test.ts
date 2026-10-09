import { afterEach, describe, expect, it, vi } from "vitest";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  decodeCollaborationSnapshot,
  snapshotChecksum,
} from "@drawstuff/collaboration/snapshot";
import {
  SNAPSHOT_REQUEST_HEADER,
  SNAPSHOT_RECEIPT_HEADER,
  snapshotRequestSchema,
} from "@drawstuff/collaboration/authority";
import { createCollaborationSnapshotStore } from "@/lib/collab/snapshot-store";
import {
  createBinarySnapshotClient,
  SnapshotHttpError,
  snapshotReadRequest,
} from "@/lib/collab/snapshot-http";
import { binarySnapshotBackend } from "./support/binary-snapshot-backend";
import { collabRectangle } from "./support/collab-scene-fixtures";

const roomId = roomIdSchema.parse("snapshot-product-room");
const elements = [collabRectangle({ id: "first" })];
const newer = [...elements, collabRectangle({ id: "second" })];
async function fixture() {
  const backend = binarySnapshotBackend(roomId);
  const store = createCollaborationSnapshotStore({ api: backend.api, roomId });
  await store.load();
  return { ...backend, store };
}
afterEach(() => vi.useRealTimers());
describe("product binary snapshot store", () => {
  it("stores the plain encoded snapshot with its checksum and reads it back", async () => {
    const f = await fixture();
    expect(await f.store.save({ elements, expectedRevision: 0 })).toMatchObject(
      { status: "written", revision: 1 },
    );
    const [operation, bytes] = f.write.mock.calls[0]!;
    expect(operation.checksum).toBe(await snapshotChecksum(bytes));
    const decoded = decodeCollaborationSnapshot(bytes, { roomId });
    expect(decoded.ok && decoded.snapshot.elements).toEqual([
      expect.objectContaining({ id: "first" }),
    ]);
    expect(await f.store.load()).toMatchObject({
      status: "loaded",
      revision: 1,
      checksum: operation.checksum,
      elements: [expect.objectContaining({ id: "first" })],
    });
  });
  it("retains the reset watermark and uses its epoch on the next write", async () => {
    const f = await fixture();
    f.emptyAt(7, 3);
    expect(await f.store.load()).toEqual({ status: "empty", revision: 7 });
    expect(await f.store.save({ elements, expectedRevision: 7 })).toMatchObject(
      { status: "written", revision: 8 },
    );
    expect(f.write.mock.calls[0]?.[0]).toMatchObject({
      authorityEpoch: 3,
      expectedRevision: 7,
    });
    expect(await f.store.load()).toMatchObject({
      status: "loaded",
      revision: 8,
      elements: [expect.objectContaining({ id: "first" })],
    });
  });
  it("refuses a damaged snapshot and never saves before a readable baseline", async () => {
    const f = await fixture();
    await f.store.save({ elements, expectedRevision: 0 });
    const stored = await f.api.read(snapshotReadRequest(roomId));
    if (!stored.found) throw new Error("expected a stored snapshot");
    stored.bytes[0] = stored.bytes[0]! ^ 0xff;
    expect(await f.store.load()).toEqual({
      status: "unreadable",
      reason: "malformed",
    });
    expect(await f.store.save({ elements, expectedRevision: 1 })).toEqual({
      status: "failed",
    });
    const uninitialized = createCollaborationSnapshotStore({
      api: f.api,
      roomId,
    });
    expect(await uninitialized.save({ elements, expectedRevision: 1 })).toEqual(
      { status: "failed" },
    );
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost reply using the original operation and bytes, without writing again", async () => {
    const f = await fixture();
    f.write.mockImplementationOnce(async (...args) => {
      await f.commit(...args);
      throw new SnapshotHttpError(503, "unavailable");
    });
    expect(await f.store.save({ elements, expectedRevision: 0 })).toEqual({
      status: "failed",
    });
    expect(f.store.hasPendingWrite?.()).toBe(true);
    const [operation, bytes] = f.write.mock.calls[0]!;
    expect(await f.store.save({ elements, expectedRevision: 0 })).toEqual({
      status: "written",
      revision: 1,
      checksum: operation.checksum,
    });
    expect(f.api.query).toHaveBeenCalledWith(operation);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(decodeCollaborationSnapshot(bytes, { roomId }).ok).toBe(true);
    expect(f.store.hasPendingWrite?.()).toBe(false);
  });
  it("does not confirm newer canvas edits with an older recovered receipt", async () => {
    const f = await fixture();
    f.write.mockImplementationOnce(async (...args) => {
      await f.commit(...args);
      throw new Error("lost-reply");
    });
    await f.store.save({ elements, expectedRevision: 0 });
    expect(
      await f.store.save({ elements: newer, expectedRevision: 0 }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    expect(await f.store.load()).toMatchObject({
      status: "loaded",
      revision: 1,
      elements: [expect.objectContaining({ id: "first" })],
    });
    expect(
      await f.store.save({ elements: newer, expectedRevision: 1 }),
    ).toMatchObject({ status: "written", revision: 2 });
    expect(f.write.mock.calls[1]?.[0].operationId).not.toBe(
      f.write.mock.calls[0]?.[0].operationId,
    );
    expect(await f.store.load()).toMatchObject({
      status: "loaded",
      revision: 2,
      elements: [
        expect.objectContaining({ id: "first" }),
        expect.objectContaining({ id: "second" }),
      ],
    });
  });
  it("retransmits byte-identical pending payloads, including a leave retry", async () => {
    const f = await fixture();
    f.write.mockResolvedValueOnce({ status: "pending" });
    expect(await f.store.save({ elements, expectedRevision: 0 })).toEqual({
      status: "failed",
    });
    expect(
      await f.store.save({ elements, expectedRevision: 0, intent: "leave" }),
    ).toMatchObject({ status: "written", revision: 1 });
    expect(f.write.mock.calls[1]?.[0]).toEqual(f.write.mock.calls[0]?.[0]);
    expect(f.write.mock.calls[1]?.[1]).toEqual(f.write.mock.calls[0]?.[1]);
    expect(f.write.mock.calls[1]?.[2]).toBe("leave");
  });
  it("keeps expired intent while cancellation is unavailable and creates nothing until a terminal receipt and reload", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.write.mockResolvedValueOnce({ status: "pending" });
    await f.store.save({ elements, expectedRevision: 0 });
    const operation = f.write.mock.calls[0]![0];
    f.results.set(operation.operationId, { status: "pending" });
    vi.setSystemTime(Date.now() + 60_001);
    vi.mocked(f.api.cancel)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ status: "cancelled" });
    expect(
      await f.store.save({ elements: newer, expectedRevision: 0 }),
    ).toEqual({ status: "failed" });
    expect(f.store.hasPendingWrite?.()).toBe(true);
    expect(
      await f.store.save({ elements: newer, expectedRevision: 0 }),
    ).toEqual({ status: "conflict", currentRevision: undefined });
    expect(f.api.cancel).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(
      await f.store.save({ elements: newer, expectedRevision: 0 }),
    ).toEqual({ status: "failed" });
    await f.store.load();
    expect(
      await f.store.save({ elements: newer, expectedRevision: 0 }),
    ).toMatchObject({ status: "written", revision: 1 });
    expect(f.write.mock.calls[1]?.[0].operationId).not.toBe(
      operation.operationId,
    );
  });
  it("settles an expired never-accepted operation without reissuing a late body", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.write.mockRejectedValueOnce(new Error("never-arrived"));
    await f.store.save({ elements, expectedRevision: 0 });
    vi.setSystemTime(Date.now() + 60_001);
    expect(await f.store.save({ elements, expectedRevision: 0 })).toEqual({
      status: "conflict",
      currentRevision: undefined,
    });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.api.cancel).not.toHaveBeenCalled();
  });
  it("never overlaps two pending writes", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.write.mockImplementationOnce(async (...args) => {
      await held;
      return f.commit(...args);
    });
    const first = f.store.save({ elements, expectedRevision: 0 });
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1));
    expect(
      await f.store.save({ elements: newer, expectedRevision: 0 }),
    ).toEqual({ status: "failed" });
    release();
    expect(await first).toMatchObject({ status: "written" });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("uses the actual binary client for lost-response receipt recovery and load", async () => {
    const backend = binarySnapshotBackend(roomId);
    let loseReply = true;
    const client = createBinarySnapshotClient(async (_url, init) => {
      const request = snapshotRequestSchema.parse(
        JSON.parse(new Headers(init?.headers).get(SNAPSHOT_REQUEST_HEADER)!),
      );
      if (request.action === "read") {
        const result = await backend.api.read(request);
        return result.found
          ? new Response(result.bytes, {
              headers: {
                "content-type": "application/octet-stream",
                [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify(result.receipt),
              },
            })
          : Response.json(
              { ok: false, code: "not-found" },
              {
                status: 404,
                headers: {
                  [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify(result.receipt),
                },
              },
            );
      }
      const result =
        request.action === "write"
          ? await backend.api.write(
              request.operation,
              new Uint8Array(init?.body as ArrayBuffer),
            )
          : await backend.api[request.action](request.operation);
      if (request.action === "write" && loseReply) {
        loseReply = false;
        throw new Error("network-reset-after-commit");
      }
      return Response.json(result);
    });
    const store = createCollaborationSnapshotStore({ api: client, roomId });
    await store.load();
    expect(await store.save({ elements, expectedRevision: 0 })).toEqual({
      status: "failed",
    });
    expect(await store.save({ elements, expectedRevision: 0 })).toMatchObject({
      status: "written",
      revision: 1,
    });
    expect(await store.load()).toMatchObject({ status: "loaded", revision: 1 });
  });
});
