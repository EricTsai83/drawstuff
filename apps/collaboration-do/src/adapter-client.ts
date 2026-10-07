import type { z } from "zod";
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
import {
  readSnapshotBody,
  readAdapterJson,
  SnapshotTransferError,
} from "./snapshot-body.ts";

type AdapterConfig = Pick<Env, "COLLAB_ADAPTER_URL" | "COLLAB_ADAPTER_SECRET">;

/** Private adapter transport; snapshot entry owns the per-Room body quota. */
export class AdapterClient {
  constructor(
    private readonly config: AdapterConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(
    input: AdapterCommand,
    responseSchema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const command = adapterCommandSchema.parse(input);
    const { url, secret } = this.endpoint();
    if (command.action === "write" || command.action.startsWith("read-"))
      throw new Error("metadata-only");
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > AUTHORITY_LIMITS.jobBytes)
      throw new Error("adapter-command-too-large");
    signal.throwIfAborted();
    const response = await this.fetchImpl(url.href, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body,
      signal,
    });
    return readAdapterJson(
      response,
      (input) => responseSchema.parse(input),
      signal,
    );
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
    const response = await this.fetchImpl(url.href, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": bytes ? "application/octet-stream" : "application/json",
        ...(bytes ? { [ADAPTER_METADATA_HEADER]: metadata } : {}),
      },
      body: bytes ?? metadata,
    });
    return readAdapterJson(
      response,
      (input) => contentResultSchema.parse(input),
      signal,
    );
  }

  async readSnapshot(
    command: Extract<AdapterCommand, { action: "read-snapshot" }>,
    signal: AbortSignal,
  ) {
    adapterCommandSchema.parse(command);
    const { url, secret } = this.endpoint();
    const response = await this.fetchImpl(url.href, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
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
      if (!parsed.found) return { ...parsed, bytes: null };
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
      return { ...parsed, bytes };
    } catch (error) {
      if (error instanceof SnapshotTransferError)
        throw new Error("adapter-response-too-large");
      throw error;
    } finally {
      await response.body?.cancel();
    }
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
