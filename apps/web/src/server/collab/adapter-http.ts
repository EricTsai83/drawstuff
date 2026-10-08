import "server-only";

import { ZodError } from "zod";
import {
  adapterCommandSchema,
  ADAPTER_METADATA_HEADER,
  ADAPTER_METADATA_MAX_BYTES,
  AUTHORITY_LIMITS,
  SNAPSHOT_RECEIPT_HEADER,
  type AdapterCommand,
} from "@drawstuff/collaboration/authority";
import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";
import {
  PERFORMANCE_PROBE_HEADER,
  formatServerTimings,
  type PerformanceTimings,
} from "@drawstuff/collaboration/performance";
import { bearerTokenMatches } from "@/server/bearer-token";
import type { Database } from "./rooms";
import {
  AdapterError,
  applyStorageFence,
  cleanupAdapterRoom,
  executeStorageOperation,
  readAdapterAssets,
  readAdapterSnapshotState,
  verifyAdapterInitialization,
} from "./authority-storage";
import {
  registerAuthorityCommand,
  createAuthorityParent,
} from "./authority-registration";
import { applyLifecycleAdapter } from "./authority-lifecycle";
import { applyRoomProjection } from "./authority-projection";

/** Enforce actual streamed bytes, regardless of Content-Length. Never hold a DB lock while reading a body. */
async function readBoundedAdapterBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw new AdapterError("body-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

function decodeCommandBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AdapterError("invalid-body");
  }
}

/** Private service endpoint only. A login session, join token, or identity proof never authenticates it. */
export async function handleAdapterRequest(
  request: Request,
  db: Database,
  secret: string | undefined,
): Promise<Response> {
  if (!bearerTokenMatches(request, secret))
    return jsonResponse({ error: "unauthorized" }, 401);
  if (request.method !== "POST")
    return jsonResponse({ error: "method-not-allowed" }, 405);
  const measuredJson = async (
    operation: () => Promise<unknown>,
    extra: PerformanceTimings = {},
  ) => {
    const start = performance.now();
    const value = await operation();
    const duration = performance.now() - start;
    const response = jsonResponse(value);
    if (request.headers.get(PERFORMANCE_PROBE_HEADER) === "1")
      response.headers.set(
        "server-timing",
        formatServerTimings({ ...extra, storage: duration }),
      );
    return response;
  };
  try {
    const metadata = request.headers.get(ADAPTER_METADATA_HEADER);
    if (
      metadata &&
      new TextEncoder().encode(metadata).byteLength > ADAPTER_METADATA_MAX_BYTES
    )
      throw new AdapterError("body-too-large");
    let command: AdapterCommand;
    try {
      command = adapterCommandSchema.parse(
        JSON.parse(
          metadata ??
            decodeCommandBody(
              await readBoundedAdapterBody(request, AUTHORITY_LIMITS.jobBytes),
            ),
        ) as unknown,
      );
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError)
        return jsonResponse({ error: "invalid-command" }, 400);
      throw error;
    }
    if (
      metadata &&
      (command.action !== "write" || command.operation.kind !== "snapshot-put")
    )
      throw new AdapterError("invalid-body");
    switch (command.action) {
      case "lifecycle-freeze":
      case "lifecycle-list":
      case "lifecycle-delete":
        return jsonResponse(await applyLifecycleAdapter(db, command));
      case "register":
        return await measuredJson(() => registerAuthorityCommand(db, command));
      case "create-parent":
        return jsonResponse(await createAuthorityParent(db, command));
      case "write":
      case "query":
      case "cancel": {
        if (
          command.action === "write" &&
          command.operation.kind === "snapshot-put" &&
          !metadata
        )
          throw new AdapterError("invalid-body");
        const bodyStart = performance.now();
        const bytes = metadata
          ? await readBoundedAdapterBody(request, MAX_SNAPSHOT_CIPHERTEXT_BYTES)
          : undefined;
        const receiveBody = performance.now() - bodyStart;
        return await measuredJson(
          () =>
            executeStorageOperation(
              db,
              command.action,
              command.operation,
              bytes,
            ),
          metadata ? { receiveBody } : {},
        );
      }
      case "fence":
        return jsonResponse(await applyStorageFence(db, command));
      case "project":
        return jsonResponse(await applyRoomProjection(db, command.event));
      case "read-assets":
        return await measuredJson(async () => ({
          assets: await readAdapterAssets(db, command, command.assetIds),
        }));
      case "verify-initialization":
        return jsonResponse(await verifyAdapterInitialization(db, command));
      case "cleanup":
        return jsonResponse(await cleanupAdapterRoom(db, command));
      case "read-snapshot": {
        const started = performance.now();
        const { snapshot, revision } = await readAdapterSnapshotState(
          db,
          command,
        );
        const timingHeaders: Record<string, string> =
          request.headers.get(PERFORMANCE_PROBE_HEADER) === "1"
            ? {
                "server-timing": formatServerTimings({
                  storage: performance.now() - started,
                }),
              }
            : {};
        if (!snapshot) {
          const response = jsonResponse({ error: "not-found" }, 404);
          for (const [name, value] of Object.entries(timingHeaders))
            response.headers.set(name, value);
          response.headers.set(
            SNAPSHOT_RECEIPT_HEADER,
            JSON.stringify({
              roomId: command.roomId,
              authGeneration: command.authGeneration,
              authorityEpoch: command.authorityEpoch,
              revision,
            }),
          );
          return response;
        }
        return new Response(new Uint8Array(snapshot.ciphertext), {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            ...timingHeaders,
            [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
              roomId: command.roomId,
              authGeneration: command.authGeneration,
              authorityEpoch: command.authorityEpoch,
              revision: snapshot.revision,
              cryptoVersion: snapshot.cryptoVersion,
              byteLength: snapshot.byteLength,
              checksum: snapshot.checksum,
            }),
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof AdapterError)
      return jsonResponse(
        { error: error.code },
        error.code === "body-too-large"
          ? 413
          : error.code === "invalid-body"
            ? 400
            : error.code === "not-found"
              ? 404
              : 409,
      );
    // Never expose SQL errors, identities, storage URLs, payloads or secrets in this response.
    return jsonResponse({ error: "adapter-unavailable" }, 503);
  }
}
