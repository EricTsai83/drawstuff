import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("server-only", () => ({}));
import {
  ADAPTER_METADATA_HEADER,
  ADAPTER_METADATA_MAX_BYTES,
  SNAPSHOT_RECEIPT_HEADER,
  snapshotAbsenceReceiptSchema,
  type AdapterCommand,
} from "@drawstuff/collaboration/authority";
import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/collab/rooms";
import { executeStorageOperation } from "@/server/collab/authority-storage";
import { handleAdapterRequest } from "@/server/collab/adapter-http";
import { openTestDatabase } from "./support/pglite-db";
import {
  adapterFixture,
  ciphertextChecksum,
  testCiphertext,
} from "./support/authority-adapter-fixtures";
const testDb = openTestDatabase();
const db = testDb as unknown as Database;
const secret = "adapter-test-service-secret-at-least-32-bytes";
const controlRequest = (command: AdapterCommand) =>
  new Request("https://adapter.invalid", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
describe("private binary adapter endpoint", () => {
  it("keeps storage timing opt-in and behind the adapter capability", async () => {
    const f = await adapterFixture(db);
    const command: AdapterCommand = {
      v: 1,
      action: "read-assets",
      roomId: f.roomId,
      authGeneration: 1,
      authorityEpoch: 1,
      assetIds: [],
    };
    const plain = await handleAdapterRequest(
      controlRequest(command),
      db,
      secret,
    );
    expect(plain.headers.get("server-timing")).toBeNull();
    const measured = controlRequest(command);
    measured.headers.set("x-collab-performance-probe", "1");
    const response = await handleAdapterRequest(measured, db, secret);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assets: [] });
    expect(response.headers.get("server-timing")).toMatch(/^storage;dur=\d/);
    const denied = await handleAdapterRequest(
      controlRequest(command),
      db,
      undefined,
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("server-timing")).toBeNull();
  });
  it.each([Error, TypeError, SyntaxError])(
    "keeps DB %s failures retryable and does not expose private driver details",
    async (Failure) => {
      const f = await adapterFixture(db);
      vi.spyOn(testDb, "transaction").mockRejectedValueOnce(
        new Failure("private database URI and provider details"),
      );
      const response = await handleAdapterRequest(
        controlRequest(f.fence()),
        db,
        secret,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "adapter-unavailable" });
    },
  );
  it("rejects malformed UTF-8 as a command error before accessing storage", async () => {
    const request = new Request("https://adapter.invalid", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: new Uint8Array([0xff]),
    });
    const response = await handleAdapterRequest(request, db, secret);
    expect(response.status).toBe(400);
  });
  it("fails closed before parsing a body without a service secret, even with browser identity metadata", async () => {
    const request = () =>
      new Request("https://adapter.invalid", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "x-room-role": "owner" },
        body: "not-json",
      });
    expect((await handleAdapterRequest(request(), db, undefined)).status).toBe(
      401,
    );
    expect(
      (await handleAdapterRequest(request(), db, "different-service-secret"))
        .status,
    ).toBe(401);
    expect(
      (
        await handleAdapterRequest(
          new Request("https://adapter.invalid", {
            headers: { authorization: `Bearer ${secret}` },
          }),
          db,
          secret,
        )
      ).status,
    ).toBe(405);
  });
  it("round trips the maximum binary snapshot without base64 and reports its immutable receipt", async () => {
    const f = await adapterFixture(db);
    const bytes = testCiphertext(MAX_SNAPSHOT_CIPHERTEXT_BYTES);
    const operation = f.operation({}, bytes);
    const response = await handleAdapterRequest(
      new Request("https://adapter.invalid", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          [ADAPTER_METADATA_HEADER]: JSON.stringify({
            v: 1,
            action: "write",
            operation,
          }),
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(bytes),
      }),
      db,
      secret,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "written", revision: 1 });
    const read = await handleAdapterRequest(
      controlRequest({
        v: 1,
        roomId: f.roomId,
        authorityEpoch: 1,
        authGeneration: 1,
        action: "read-snapshot",
      }),
      db,
      secret,
    );
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(
      JSON.parse(read.headers.get("x-drawstuff-snapshot") ?? "null") as unknown,
    ).toMatchObject({
      revision: 1,
      checksum: operation.checksum,
      byteLength: MAX_SNAPSHOT_CIPHERTEXT_BYTES,
    });
    const returned = new Uint8Array(await read.arrayBuffer());
    expect(returned.byteLength).toBe(MAX_SNAPSHOT_CIPHERTEXT_BYTES);
    expect(ciphertextChecksum(returned)).toBe(operation.checksum);
    expect(
      await (
        await handleAdapterRequest(
          controlRequest({ v: 1, action: "query", operation }),
          db,
          secret,
        )
      ).json(),
    ).toEqual({ status: "written", revision: 1 });
  });
  it("returns the locked revision on an absent snapshot after reset, allowing the next conditional write", async () => {
    const f = await adapterFixture(db);
    await executeStorageOperation(db, "write", f.operation(), testCiphertext());
    const reset = f.operation({
      kind: "snapshot-reset",
      expectedRevision: 1,
      checksum: ciphertextChecksum(new Uint8Array()),
    });
    expect(
      await (
        await handleAdapterRequest(
          controlRequest({ v: 1, action: "write", operation: reset }),
          db,
          secret,
        )
      ).json(),
    ).toEqual({ status: "written", revision: 2 });
    const read = await handleAdapterRequest(
      controlRequest({
        v: 1,
        action: "read-snapshot",
        roomId: f.roomId,
        authGeneration: 1,
        authorityEpoch: 1,
      }),
      db,
      secret,
    );
    expect(read.status).toBe(404);
    const receipt = snapshotAbsenceReceiptSchema.parse(
      JSON.parse(read.headers.get(SNAPSHOT_RECEIPT_HEADER)!) as unknown,
    );
    expect(receipt).toEqual({
      roomId: f.roomId,
      authGeneration: 1,
      authorityEpoch: 1,
      revision: 2,
    });
    expect(
      await executeStorageOperation(
        db,
        "write",
        f.operation({ expectedRevision: receipt.revision }),
        testCiphertext(),
      ),
    ).toEqual({ status: "written", revision: 3 });
  });
  it("bounds actual chunked bytes despite a misleading Content-Length and cancels excess input", async () => {
    const f = await adapterFixture(db);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(testCiphertext(MAX_SNAPSHOT_CIPHERTEXT_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleAdapterRequest(
      new Request("https://adapter.invalid", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-length": "1",
          [ADAPTER_METADATA_HEADER]: JSON.stringify({
            v: 1,
            action: "write",
            operation: f.operation(),
          }),
        },
        body,
        duplex: "half",
      } as RequestInit),
      db,
      secret,
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(
      await testDb.query.collaborationSnapshot.findFirst({
        where: eq(schema.collaborationSnapshot.roomId, f.roomId),
      }),
    ).toBeUndefined();
  });
  it("rejects oversized metadata, JSON snapshots, unknown fields and mismatched operations", async () => {
    const f = await adapterFixture(db);
    const oversized = new Request("https://adapter.invalid", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        [ADAPTER_METADATA_HEADER]: "a".repeat(ADAPTER_METADATA_MAX_BYTES + 1),
      },
    });
    expect((await handleAdapterRequest(oversized, db, secret)).status).toBe(
      413,
    );
    expect(
      (
        await handleAdapterRequest(
          controlRequest({ v: 1, action: "write", operation: f.operation() }),
          db,
          secret,
        )
      ).status,
    ).toBe(400);
    const unknown = new Request("https://adapter.invalid", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ ...f.fence(), role: "owner" }),
    });
    expect((await handleAdapterRequest(unknown, db, secret)).status).toBe(400);
    const operation = f.operation();
    await handleAdapterRequest(
      controlRequest({ v: 1, action: "cancel", operation }),
      db,
      secret,
    );
    expect(
      (
        await handleAdapterRequest(
          controlRequest({
            v: 1,
            action: "query",
            operation: { ...operation, expectedRevision: 1 },
          }),
          db,
          secret,
        )
      ).status,
    ).toBe(409);
  });
});
