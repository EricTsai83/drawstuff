import { env, SELF } from "cloudflare:test";
import { z } from "zod";
import { checksum, resultSchema, type Operation } from "./contracts.ts";
import type { P0Env } from "./worker.ts";

export const bindings = env as unknown as P0Env;
export const fresh = async (
  overrides: Partial<Operation> = {},
  bytes: Uint8Array = new Uint8Array([1, 2, 3]),
): Promise<Operation> => ({
  roomId: `p0-${crypto.randomUUID()}`,
  operationId: crypto.randomUUID(),
  actor: "writer",
  epoch: 1,
  authGeneration: 1,
  expectedRevision: 0,
  checksum: await checksum(bytes),
  deadline: Date.now() + 55_000,
  ...overrides,
});
export const call = async (
  path: string,
  operation: Operation,
  bytes?: Uint8Array,
  extraHeaders: Record<string, string> = {},
): Promise<Response> => {
  const response = await SELF.fetch(`http://p0${path}`, {
    method: "POST",
    headers: {
      "x-p0-operation": JSON.stringify(operation),
      "content-type": "application/octet-stream",
      ...extraHeaders,
      ...(path === "/socket" ? { Upgrade: "websocket" } : {}),
    },
    body: bytes ? new Uint8Array(bytes) : undefined,
  });
  // Consume the DO response before eviction; an unread body keeps the original
  // request alive. Preserve upgraded sockets instead of reconstructing them.
  if (response.status === 101) return response;
  const responseBytes = await response.arrayBuffer();
  return new Response(responseBytes.byteLength ? responseBytes : null, {
    status: response.status,
    headers: response.headers,
  });
};
export const direct = (
  path: string,
  operation: Operation,
  bytes?: Uint8Array,
): Promise<Response> =>
  bindings.P0_ADAPTER.fetch(`http://adapter${path}`, {
    method: "POST",
    headers: { "x-p0-operation": JSON.stringify(operation) },
    body: bytes ? new Uint8Array(bytes) : undefined,
  });
export const control = async (
  path: string,
  id?: string,
  unavailable?: boolean,
) => {
  const response = await bindings.P0_ADAPTER.fetch(
    `http://adapter/test/${path}`,
    { method: "POST", body: JSON.stringify({ id, unavailable }) },
  );
  return z
    .object({ reached: z.boolean(), locks: z.number(), sessions: z.number() })
    .parse(await response.json());
};
export const until = async (
  condition: () => Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture condition not reached");
};
export const result = async (response: Promise<Response>) =>
  resultSchema.parse(await (await response).json());
