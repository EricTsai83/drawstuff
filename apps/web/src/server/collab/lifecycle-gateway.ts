import "server-only";
import { type z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AUTHORITY_LIMITS,
  LIFECYCLE_GATEWAY_PATH,
  lifecycleGatewayRequestSchema,
} from "@drawstuff/collaboration/authority";
import { env } from "@/env";

/** Service-only transport; callers authorize admin/owner/maintenance before constructing a command. */
export async function callLifecycleGateway<T>(
  input: z.infer<typeof lifecycleGatewayRequestSchema>,
  schema: z.ZodType<T>,
): Promise<T> {
  const secret = env.COLLAB_AUTHORITY_SECRET;
  const url = new URL(LIFECYCLE_GATEWAY_PATH, env.COLLAB_CONTROL_URL);
  if (
    !secret ||
    secret.length < 32 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(lifecycleGatewayRequestSchema.parse(input)),
      signal: AbortSignal.timeout(AUTHORITY_LIMITS.externalTimeoutMs),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("unconfirmed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > AUTHORITY_LIMITS.jobBytes)
          throw new Error("response-too-large");
        chunks.push(part.value);
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
    return schema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
    );
  } catch {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message:
        "Retirement is not confirmed. Retry to resume the same operation.",
    });
  }
}
