import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it } from "vitest";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import {
  createAssetCryptoCodec,
  encodeCollaborationAssetPayload,
  decodeCollaborationAssetPayload,
} from "@drawstuff/collaboration/asset";
import {
  deriveSnapshotKey,
  sealCollaborationSnapshot,
  openCollaborationSnapshot,
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  decodeCollaborationSnapshot,
} from "@drawstuff/collaboration/snapshot";
import { canvasFixture } from "./canvas-fixture.ts";
import { checksum, type Operation } from "./contracts.ts";
import {
  bindings,
  call,
  control,
  direct,
  fresh,
  result,
  until,
} from "./support.ts";

const SAMPLES = 200;
const WARMUP = 20;
const TYPICAL_BYTES = 256 * 1024;
let assetPlaintextBytes = 0;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
type Sample = {
  ms: number;
  status: "completed" | "pending" | "failed";
  localDenyMs?: number;
  presenceMs?: number;
  cryptoMs?: number;
  initializationMs?: number;
  preparationMs?: number;
};
const percentile = (values: number[], quantile: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(
      (sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0) * 100,
    ) / 100
  );
};
const report = async (
  name: string,
  bytes: number,
  samples: Sample[],
  limits?: { p95: number; p99: number },
) => {
  const times = samples
    .filter((sample) => sample.status === "completed")
    .map((sample) => sample.ms);
  const stats = {
    name,
    payloadBytes: bytes,
    assetPlaintextBytes: bytes ? assetPlaintextBytes : 0,
    sampleCount: samples.length,
    warmup: WARMUP,
    completed: times.length,
    failed: samples.filter((sample) => sample.status === "failed").length,
    pending: samples.filter((sample) => sample.status === "pending").length,
    failureRatio:
      samples.filter((sample) => sample.status === "failed").length /
      samples.length,
    pendingRatio:
      samples.filter((sample) => sample.status === "pending").length /
      samples.length,
    cryptoP95Ms: percentile(
      samples.flatMap((sample) =>
        sample.cryptoMs === undefined ? [] : [sample.cryptoMs],
      ),
      0.95,
    ),
    initializationP95Ms: percentile(
      samples.flatMap((sample) =>
        sample.initializationMs === undefined ? [] : [sample.initializationMs],
      ),
      0.95,
    ),
    preparationP95Ms: percentile(
      samples.flatMap((sample) =>
        sample.preparationMs === undefined ? [] : [sample.preparationMs],
      ),
      0.95,
    ),
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    p99Ms: percentile(times, 0.99),
    limitsMs: limits ?? null,
    localDenyP99Ms: percentile(
      samples.flatMap((sample) =>
        sample.localDenyMs === undefined ? [] : [sample.localDenyMs],
      ),
      0.99,
    ),
    presenceP99Ms: percentile(
      samples.flatMap((sample) =>
        sample.presenceMs === undefined ? [] : [sample.presenceMs],
      ),
      0.99,
    ),
  };
  await bindings.P0_ADAPTER.fetch("http://adapter/test/report", {
    method: "POST",
    body: JSON.stringify({ report: stats }),
  });
  console.log(JSON.stringify(stats));
  expect(stats.completed).toBe(SAMPLES);
  expect(stats.failed).toBe(0);
  expect(stats.pending).toBe(0);
  if (limits) {
    expect(stats.p95Ms).toBeLessThanOrEqual(limits.p95);
    expect(stats.p99Ms).toBeLessThanOrEqual(limits.p99);
  }
};
async function batch<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const values: T[] = [];
  for (let offset = 0; offset < count; offset += concurrency) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(concurrency, count - offset) }, (_, i) =>
        task(offset + i),
      ),
    );
    values.push(...chunk);
  }
  return values;
}
async function fixture(size: number) {
  const roomId = roomIdSchema.parse(`p0-${crypto.randomUUID()}`);
  const roomKey = generateRoomKey();
  const key = await deriveSnapshotKey({ roomKey, roomId, authGeneration: 1 });
  const assetId = crypto.randomUUID();
  const sealed = await sealCollaborationSnapshot({
    key,
    roomId,
    authGeneration: 1,
    revision: 1,
    plaintext: canvasFixture(roomId, size, assetId),
  });
  if (!sealed.ok) throw new Error("fixture encryption failed");
  const codec = await createAssetCryptoCodec({
    roomKey,
    roomId,
    authGeneration: 1,
  });
  const assetBytes = await codec.seal({
    excalidrawFileId: assetId,
    plaintext: (() => {
      const png = atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT7sAAAAASUVORK5CYII=",
      );
      const encoded = encodeCollaborationAssetPayload({
        roomId,
        excalidrawFileId: assetId,
        mimeType: "image/png",
        dataUrl: "data:image/png;base64," + btoa(png + "\0".repeat(48 * 1024)),
      });
      if (!encoded.ok) throw new Error("fixture asset payload invalid");
      assetPlaintextBytes = encoded.bytes.length;
      return encoded.bytes;
    })(),
  });
  if (!assetBytes.ok) throw new Error("fixture asset encryption failed");
  const asset = await fresh(
    { actor: "owner", roomId, operationId: assetId },
    assetBytes.ciphertext,
  );
  const snapshot = await fresh(
    { actor: "owner", roomId, assetIds: [assetId] },
    sealed.ciphertext,
  );
  return {
    codec,
    key,
    roomId,
    asset,
    assetBytes: assetBytes.ciphertext,
    snapshot,
    bytes: sealed.ciphertext,
  };
}
async function save(item: Awaited<ReturnType<typeof fixture>>) {
  expect(
    (await result(direct("/asset-upload", item.asset, item.assetBytes))).status,
  ).toBe("written");
  expect((await result(call("/asset-finalize", item.asset))).status).toBe(
    "written",
  );
  expect(await result(call("/write", item.snapshot, item.bytes))).toEqual({
    status: "written",
    revision: 1,
  });
}
async function dispose(operation: Operation) {
  await bindings.P0_ADAPTER.fetch("http://adapter/fence", {
    method: "POST",
    body: JSON.stringify({
      roomId: operation.roomId,
      epoch: operation.epoch + 1,
      closed: true,
    }),
  });
  await bindings.P0_ADAPTER.fetch("http://adapter/cleanup", {
    method: "POST",
    body: JSON.stringify({ roomId: operation.roomId }),
  });
  await evictDurableObject(bindings.P0_ROOM.getByName(operation.roomId));
}
async function normalScenario(name: string, size: number, cold: boolean) {
  const run = async (): Promise<{ save: Sample; join: Sample }> => {
    const start = performance.now();
    const item = await fixture(size);
    const cryptoMs = performance.now() - start;
    const create = { ...item.snapshot, operationId: crypto.randomUUID() };
    const keyHeaders = { "x-p0-key-check": "a".repeat(64) };
    expect((await call("/create", create, undefined, keyHeaders)).status).toBe(
      200,
    );
    if (cold) {
      // Instantiate then evict; this measures a real SQLite rehydration, not a new empty name.
      await call("/asset-index", item.snapshot);
      await evictDurableObject(bindings.P0_ROOM.getByName(item.roomId));
    } else {
      await call("/asset-index", item.snapshot);
    }
    const savingStart = performance.now();
    await save(item);
    const saveMs = cryptoMs + performance.now() - savingStart;
    const initializationStart = performance.now();
    expect(
      await (
        await call("/initialize-finish", item.snapshot, undefined, keyHeaders)
      ).json(),
    ).toEqual({ status: "ready" });
    const initializationMs = performance.now() - initializationStart;
    if (cold) await evictDurableObject(bindings.P0_ROOM.getByName(item.roomId));
    const joinStart = performance.now();
    {
      const response = await call("/join", {
        ...item.snapshot,
        actor: "writer",
      });
      expect(response.status).toBe(200);
      const opened = await openCollaborationSnapshot({
        key: item.key,
        roomId: item.roomId,
        authGeneration: 1,
        revision: 1,
        ciphertext: new Uint8Array(await response.arrayBuffer()),
      });
      if (!opened.ok) throw new Error("fixture baseline did not decrypt");
      expect(opened.plaintext.length).toBe(size);
      const decoded = decodeCollaborationSnapshot(opened.plaintext, {
        roomId: item.roomId,
      });
      if (!decoded.ok) throw new Error("baseline is not a valid canvas");
      expect(
        decoded.snapshot.elements.some(
          (element) => element.fileId === item.asset.operationId,
        ),
      ).toBe(true);
      const assetResponse = await direct("/asset-read", item.asset);
      expect(assetResponse.status).toBe(200);
      const asset = await item.codec.open({
        excalidrawFileId: item.asset.operationId,
        ciphertext: new Uint8Array(await assetResponse.arrayBuffer()),
      });
      if (!asset.ok) throw new Error("attachment did not decrypt");
      expect(
        decodeCollaborationAssetPayload(asset.plaintext, {
          roomId: item.roomId,
          excalidrawFileId: item.asset.operationId,
        }).ok,
      ).toBe(true);
    }
    const joinMs = performance.now() - joinStart;
    await dispose(item.snapshot);
    return {
      save: {
        ms: saveMs,
        status: "completed",
        cryptoMs,
        initializationMs,
        preparationMs: savingStart - start - cryptoMs,
      },
      join: { ms: joinMs, status: "completed" },
    };
  };
  await batch(WARMUP, 2, run);
  const samples = await batch(SAMPLES, 2, run);
  const limits =
    size === MAX_SNAPSHOT_PLAINTEXT_BYTES
      ? { p95: 8000, p99: 15000 }
      : { p95: 3000, p99: 8000 };
  await report(
    `save-${name}`,
    size,
    samples.map((sample) => sample.save),
    limits,
  );
  await report(
    `join-${name}`,
    size,
    samples.map((sample) => sample.join),
    { p95: 3000, p99: 5000 },
  );
}

it("measures complete local saves, joins, revocation, slow attachments and outage recovery", async () => {
  for (const size of [TYPICAL_BYTES, MAX_SNAPSHOT_PLAINTEXT_BYTES]) {
    for (const cold of [false, true]) {
      await normalScenario(
        `${size === TYPICAL_BYTES ? "typical" : "maximum"}-${cold ? "cold" : "hot"}`,
        size,
        cold,
      );
    }
  }
  const concurrent = async (): Promise<Sample> => {
    const item = await fixture(TYPICAL_BYTES);
    const writer = { ...item.snapshot, actor: "writer" as const };
    await direct("/asset-upload", item.asset, item.assetBytes);
    await call("/asset-finalize", item.asset);
    const gate = `locked:${writer.operationId}`;
    await control("hold", gate);
    const writing = call("/write", writer, item.bytes);
    await until(async () => (await control("state", gate)).reached);
    const start = performance.now();
    const revoking = call("/revoke", writer);
    await until(
      async () => (await call("/asset-index", writer)).status === 403,
    );
    const localDenyMs = performance.now() - start;
    await control("release", gate);
    expect(await (await revoking).json()).toEqual({ status: "enforced" });
    expect((await result(Promise.resolve(writing))).status).toBe("written");
    const ms = performance.now() - start;
    expect((await call("/join", writer)).status).toBe(403);
    expect(
      (await call("/asset-finalize", { ...item.asset, actor: "writer" }))
        .status,
    ).toBe(403);
    await dispose({ ...item.snapshot, epoch: 2 });
    return { ms, status: "completed", localDenyMs };
  };
  await batch(WARMUP, 2, concurrent);
  await report(
    "save-and-revoke",
    TYPICAL_BYTES,
    await batch(SAMPLES, 2, concurrent),
    { p95: 3000, p99: 5000 },
  );

  const slow = async (): Promise<Sample> => {
    const item = await fixture(TYPICAL_BYTES);
    const writer = { ...item.snapshot, actor: "writer" as const };
    const socket = (await call("/socket", writer)).webSocket;
    const receiver = (await call("/socket", writer)).webSocket;
    if (!socket || !receiver) throw new Error("missing socket");
    socket.accept();
    receiver.accept();
    const gate = `upload:${item.asset.operationId}`;
    await control("hold", gate);
    const start = performance.now();
    const uploading = direct("/asset-upload", item.asset, item.assetBytes);
    await until(async () => (await control("state", gate)).reached);
    expect(
      (await result(call("/write", item.snapshot, item.bytes))).status,
    ).toBe("pending");
    const echoStart = performance.now();
    const echo = new Promise<void>((resolve) =>
      receiver.addEventListener("message", () => resolve(), { once: true }),
    );
    socket.send("presence");
    await echo;
    const presenceMs = performance.now() - echoStart;
    const denyStart = performance.now();
    await call("/revoke", writer);
    expect((await call("/asset-index", writer)).status).toBe(403);
    const localDenyMs = performance.now() - denyStart;
    await sleep(Math.max(0, 5000 - (performance.now() - start)));
    await control("release", gate);
    expect((await result(Promise.resolve(uploading))).status).toBe("refused");
    // Owner retries under the new epoch; completion still includes finalize and snapshot commit.
    const replacement = {
      ...item.asset,
      epoch: 2,
      deadline: Date.now() + 55_000,
    };
    await direct("/asset-upload", replacement, item.assetBytes);
    await call("/asset-finalize", replacement);
    const snapshot = {
      ...item.snapshot,
      operationId: crypto.randomUUID(),
      epoch: 2,
      assetIds: [replacement.operationId],
      deadline: Date.now() + 55_000,
    };
    expect((await result(call("/write", snapshot, item.bytes))).status).toBe(
      "written",
    );
    const ms = performance.now() - start;
    expect(ms).toBeGreaterThanOrEqual(5000);
    socket.close();
    receiver.close();
    await dispose(snapshot);
    return { ms, status: "completed", localDenyMs, presenceMs };
  };
  await batch(WARMUP, 8, slow);
  await report(
    "slow-attachment-5s",
    TYPICAL_BYTES,
    await batch(SAMPLES, 8, slow),
    { p95: 8000, p99: 15000 },
  );

  // One shared 30-second outage, 20 warmup + 200 independent rooms. Recovery is
  // measured separately; provider failure is never presented as enforcement.
  const operations = await batch(WARMUP + SAMPLES, 8, () => fresh());
  const outageStart = performance.now();
  await control("fault", undefined, true);
  try {
    await batch(operations.length, 8, async (index) => {
      const operation = operations[index];
      if (!operation) throw new Error("missing operation");
      expect(
        (
          await result(
            call(
              "/write",
              { ...operation, actor: "owner" },
              new Uint8Array([1, 2, 3]),
            ),
          )
        ).status,
      ).toBe("pending");
      expect((await call("/revoke", operation)).status).toBe(202);
      expect((await call("/join", operation)).status).toBe(403);
    });
    await sleep(Math.max(0, 30_000 - (performance.now() - outageStart)));
  } finally {
    await control("fault", undefined, false);
  }
  const recoveryStart = performance.now();
  const recovered = await batch(operations.length, 8, async (index) => {
    const operation = operations[index];
    if (!operation) throw new Error("missing operation");
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    // A 30-second outage may naturally hibernate the object. Wake it and
    // confirm persisted denial before the helper's explicit eviction.
    expect((await call("/join", operation)).status).toBe(403);
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE work SET next_at=0");
    });
    await runDurableObjectAlarm(stub);
    expect(await (await call("/revoke", operation)).json()).toEqual({
      status: "enforced",
    });
    const saved = { ...operation, actor: "owner" as const };
    // Alarm queries a missing payload; after its original deadline it cancels.
    expect((await result(call("/status", saved))).status).toBe("pending");
    expect((await result(call("/cancel", saved))).status).toBe("cancelled");
    expect(
      (await result(direct("/write", operation, new Uint8Array([1, 2, 3]))))
        .status,
    ).toBe("refused");
    return {
      ms: performance.now() - recoveryStart,
      status: "completed" as const,
    };
  });
  await report("db-outage-30s-recovery", 0, recovered.slice(WARMUP));
  // Independently check provider-to-DO metadata contains no body/key artifacts.
  const reference = await fresh();
  await call("/asset-index", reference);
  expect(await checksum(new Uint8Array([1, 2, 3]))).toBe(reference.checksum);
}, 1_800_000);
