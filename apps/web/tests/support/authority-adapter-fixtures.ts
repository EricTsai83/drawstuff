import { createHash } from "node:crypto";
import type {
  ContentOperation,
  ProjectionEvent,
  InviteProjectionEvent,
  AdapterCommand,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { collaborationRoom, user } from "@/server/db/schema";
import type { Database } from "@/server/collab/rooms";

export const testSnapshotBytes = (length = 32): Uint8Array =>
  new Uint8Array(length).fill(7);
export const bytesChecksum = (bytes: Uint8Array): string =>
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
    bytes = testSnapshotBytes(),
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
    authorityEpoch: 1,
    expectedRevision: 0,
    checksum: bytesChecksum(bytes),
    ...overrides,
  });
  /** Tombstones clear role (and access), as the contract requires. */
  const projection = (
    overrides: Partial<ProjectionEvent> = {},
  ): ProjectionEvent => {
    const event: ProjectionEvent = {
      v: 1,
      roomId,
      subject: guest,
      version: 2,
      status: "ready",
      role: "editor",
      access: "invited",
      tombstone: false,
      label: "Independent",
      sceneId: null,
      listedAt: 100,
      ...overrides,
    };
    return event.tombstone ? { ...event, role: null, access: null } : event;
  };
  const fence = (
    authorityEpoch = 2,
    overrides: Partial<Extract<AdapterCommand, { action: "fence" }>> = {},
  ): Extract<AdapterCommand, { action: "fence" }> => ({
    v: 1,
    action: "fence",
    roomId,
    authorityEpoch,
    state: "ready",
    ...overrides,
  });
  const invite = (
    overrides: Partial<InviteProjectionEvent> = {},
  ): InviteProjectionEvent => {
    const event: InviteProjectionEvent = {
      v: 1,
      roomId,
      email: `${guest}@example.com`,
      version: 2,
      status: "ready",
      role: "editor",
      tombstone: false,
      label: "Independent",
      sceneId: null,
      listedAt: 100,
      ...overrides,
    };
    return event.tombstone ? { ...event, role: null } : event;
  };
  return { owner, guest, roomId, operation, projection, invite, fence };
}
