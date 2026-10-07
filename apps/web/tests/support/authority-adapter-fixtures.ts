import { createHash } from "node:crypto";
import type {
  ContentOperation,
  ProjectionEvent,
  AdapterCommand,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { MIN_SNAPSHOT_SEALED_BYTES } from "@drawstuff/collaboration/snapshot";
import { collaborationRoom, user } from "@/server/db/schema";
import type { Database } from "@/server/collab/rooms";

export const testCiphertext = (
  length = MIN_SNAPSHOT_SEALED_BYTES,
): Uint8Array => {
  const bytes = new Uint8Array(length).fill(7);
  bytes[0] = 1;
  return bytes;
};
export const ciphertextChecksum = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export async function adapterFixture(db: Database) {
  const owner = `adapter-${crypto.randomUUID()}`;
  const guest = `guest-${crypto.randomUUID()}`;
  const roomId = roomIdSchema.parse(`adapter-${crypto.randomUUID()}`);
  await db.insert(user).values([
    { id: owner, name: "Owner", email: `${owner}@example.com` },
    { id: guest, name: "Guest", email: `${guest}@example.com` },
  ]);
  await db
    .insert(collaborationRoom)
    .values({ roomId, ownerId: owner, status: "ready", storageState: "ready" });
  const operation = (
    overrides: Partial<ContentOperation> = {},
    bytes = testCiphertext(),
  ): ContentOperation => ({
    v: 1,
    operationId: crypto.randomUUID(),
    roomId,
    actor: {
      subject: owner,
      email: `${owner}@example.com`,
      lifecycleVersion: 1,
    },
    deadline: Date.now() + 55_000,
    kind: "snapshot-put",
    authGeneration: 1,
    authorityEpoch: 1,
    expectedRevision: 0,
    checksum: ciphertextChecksum(bytes),
    ...overrides,
  });
  const projection = (
    overrides: Partial<ProjectionEvent> = {},
  ): ProjectionEvent => ({
    v: 1,
    roomId,
    subject: guest,
    version: 2,
    status: "ready",
    role: "editor",
    tombstone: false,
    label: "Independent",
    sceneId: null,
    listedAt: 100,
    ...overrides,
  });
  const fence = (
    authorityEpoch = 2,
    overrides: Partial<Extract<AdapterCommand, { action: "fence" }>> = {},
  ): Extract<AdapterCommand, { action: "fence" }> => ({
    v: 1,
    action: "fence",
    roomId,
    authorityEpoch,
    authGeneration: 1,
    state: "ready",
    ...overrides,
  });
  return { owner, guest, roomId, operation, projection, fence };
}
