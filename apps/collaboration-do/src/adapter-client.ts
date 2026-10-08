import type { z } from "zod";
import {
  PERFORMANCE_PROBE_HEADER,
  readServerTimings,
  type PerformanceTimings,
} from "@drawstuff/collaboration/performance";
import {
  adapterCommandSchema,
  AUTHORITY_LIMITS,
  type AdapterCommand,
  type ContentOperation,
  ADAPTER_METADATA_HEADER,
  ADAPTER_METADATA_MAX_BYTES,
  SNAPSHOT_RECEIPT_HEADER,
  snapshotReceiptSchema,
  snapshotAbsenceReceiptSchema,
  contentResultSchema,
} from "@drawstuff/collaboration/authority";

import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";
import { createDoLogger } from "./logger.ts";
import {
  readSnapshotBody,
  readAdapterJson,
  SnapshotTransferError,
} from "./snapshot-body.ts";

type AdapterConfig = Pick<Env, "COLLAB_ADAPTER_URL" | "COLLAB_ADAPTER_SECRET"> &
  Partial<Pick<Env, "VERSION_METADATA">>;

/** Private adapter transport; snapshot entry owns the per-Room body quota. */
export class AdapterClient {
  constructor(
    private readonly config: AdapterConfig,
    private readonly fetchImpl: typeof fetch = (...args) =>
      globalThis.fetch(...args),
    private readonly timings?: PerformanceTimings,
  ) {}

  async call<T>(
    input: AdapterCommand,
    responseSchema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const command = adapterCommandSchema.parse(input);
    const { url, secret } = this.endpoint();
    if (
      (command.action === "write" &&
        command.operation.kind !== "asset-finalize") ||
      command.action === "read-snapshot"
    )
      throw new Error("metadata-only");
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > AUTHORITY_LIMITS.jobBytes)
      throw new Error("adapter-command-too-large");
    signal.throwIfAborted();
    const started = performance.now();
    const response = await this.fetchImpl(url.href, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        ...(this.timings ? { [PERFORMANCE_PROBE_HEADER]: "1" } : {}),
      },
      body,
      signal,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("application/json")
    )
      createDoLogger(this.config.VERSION_METADATA).warn(
        "adapter.delivery_failed",
        { status: response.status },
      );
    const value = await readAdapterJson(
      response,
      (input) => responseSchema.parse(input),
      signal,
    );
    if (this.timings) {
      const metric =
        command.action === "register"
          ? "register"
          : command.action === "read-assets"
            ? "readAssets"
            : command.action === "write"
              ? "write"
              : undefined;
      if (metric) {
        this.observe(response, metric, started);
      }
    }
    return value;
  }

  async writeSnapshot(
    operation: ContentOperation,
    bytes: Uint8Array | undefined,
    signal: AbortSignal,
  ) {
    const command = adapterCommandSchema.parse({
      v: 1,
      action: "write",
      operation,
    });
    if (
      command.action !== "write" ||
      command.operation.kind === "asset-finalize"
    )
      throw new Error("snapshot-only");
    const { url, secret } = this.endpoint();
    const metadata = JSON.stringify(command);
    if (
      new TextEncoder().encode(metadata).byteLength > ADAPTER_METADATA_MAX_BYTES
    )
      throw new Error("adapter-command-too-large");
    if (bytes && bytes.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES)
      throw new Error("payload-too-large");
    signal.throwIfAborted();
    const started = performance.now();
    const response = await this.fetchImpl(url.href, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": bytes ? "application/octet-stream" : "application/json",
        ...(bytes ? { [ADAPTER_METADATA_HEADER]: metadata } : {}),
        ...(this.timings ? { [PERFORMANCE_PROBE_HEADER]: "1" } : {}),
      },
      body: bytes ?? metadata,
    });
    const result = await readAdapterJson(
      response,
      (input) => contentResultSchema.parse(input),
      signal,
    );
    this.observe(response, "write", started);
    return result;
  }

  async readSnapshot(
    command: Extract<AdapterCommand, { action: "read-snapshot" }>,
    signal: AbortSignal,
  ) {
    adapterCommandSchema.parse(command);
    const { url, secret } = this.endpoint();
    const started = performance.now();
    const response = await this.fetchImpl(url.href, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        ...(this.timings ? { [PERFORMANCE_PROBE_HEADER]: "1" } : {}),
      },
      body: JSON.stringify(command),
    });
    try {
      signal.throwIfAborted();
      if (
        response.status !== 404 &&
        (!response.ok ||
          response.headers.get("content-type") !== "application/octet-stream")
      )
        throw new Error("adapter-delivery-failed");
      const header = response.headers.get(SNAPSHOT_RECEIPT_HEADER);
      if (
        !header ||
        new TextEncoder().encode(header).byteLength > ADAPTER_METADATA_MAX_BYTES
      )
        throw new Error("adapter-invalid-response");
      const rawReceipt: unknown = JSON.parse(header);
      const parsed =
        response.status === 404
          ? {
              found: false as const,
              receipt: snapshotAbsenceReceiptSchema.parse(rawReceipt),
            }
          : {
              found: true as const,
              receipt: snapshotReceiptSchema.parse(rawReceipt),
            };
      const receipt = parsed.receipt;
      if (
        receipt.roomId !== command.roomId ||
        receipt.authGeneration !== command.authGeneration ||
        receipt.authorityEpoch !== command.authorityEpoch
      )
        throw new Error("adapter-invalid-response");
      if (!parsed.found) {
        this.observe(response, "readSnapshot", started);
        return { ...parsed, bytes: null };
      }
      const snapshotReceipt = parsed.receipt;
      if (snapshotReceipt.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES)
        throw new Error("adapter-invalid-response");
      const bytes = await readSnapshotBody(
        response.body,
        MAX_SNAPSHOT_CIPHERTEXT_BYTES,
        signal,
      );
      if (bytes.byteLength !== snapshotReceipt.byteLength)
        throw new Error("adapter-invalid-response");
      this.observe(response, "readSnapshot", started);
      return { ...parsed, bytes };
    } catch (error) {
      if (error instanceof SnapshotTransferError)
        throw new Error("adapter-response-too-large");
      throw error;
    } finally {
      await response.body?.cancel();
    }
  }

  private observe(
    response: Response,
    metric: "register" | "readAssets" | "write" | "readSnapshot",
    started: number,
  ) {
    if (!this.timings) return;
    this.timings[metric] = performance.now() - started;
    const server = readServerTimings(response.headers.get("server-timing"));
    if (server.storage !== undefined)
      this.timings[`${metric}Storage`] = server.storage;
    if (server.receiveBody !== undefined)
      this.timings.adapterReceiveBody = server.receiveBody;
  }

  private endpoint() {
    const { COLLAB_ADAPTER_URL: endpoint, COLLAB_ADAPTER_SECRET: secret } =
      this.config;
    if (!endpoint || !secret || secret.length < 32)
      throw new Error("adapter-unconfigured");
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/internal/collaboration/adapter"
    )
      throw new Error("adapter-unconfigured");
    return { url, secret };
  }
}
