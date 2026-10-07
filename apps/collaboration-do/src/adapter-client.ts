import type { z } from "zod";
import {
  adapterCommandSchema,
  AUTHORITY_LIMITS,
  type AdapterCommand,
} from "@drawstuff/collaboration/authority";

type AdapterConfig = Pick<Env, "COLLAB_ADAPTER_URL" | "COLLAB_ADAPTER_SECRET">;

/** Metadata-only client. Payload forwarding gets its own quota in the content entry unit. */
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
    try {
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("application/json")
      )
        throw new Error("adapter-delivery-failed");
      if (!response.body) throw new Error("adapter-invalid-response");
      // workerd declares HTTP bodies as an unparameterized stream; fetch body chunks are bytes.
      const reader =
        response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      });
      let bytes = 0;
      let json = "";
      try {
        while (true) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > AUTHORITY_LIMITS.jobBytes)
            throw new Error("adapter-response-too-large");
          json += decoder.decode(chunk.value, { stream: true });
        }
        json += decoder.decode();
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      signal.throwIfAborted();
      return responseSchema.parse(JSON.parse(json) as unknown);
    } finally {
      await response.body?.cancel();
    }
  }
}
