import { z } from "zod";

import { COLLABORATION_PROTOCOL_VERSION, roomIdSchema } from "./messages.ts";
import { roomAuthGenerationSchema, roomRoleSchema } from "./room-auth.ts";
import { KEYCHECK_CIPHERTEXT_BYTES } from "./keycheck.ts";
import {
  collaborationAssetRecordSchema,
  MAX_ROOM_ASSETS_PER_GENERATION,
} from "./asset.ts";

/** Metadata only. Neither proofs nor durable jobs carry plaintext or room keys. */
export const AUTHORITY_CONTRACT_VERSION = 1;
export const AUTHORITY_LIMITS = {
  externalTimeoutMs: 15_000,
  operationTtlMs: 60_000,
  initializationTtlMs: 15 * 60_000,
  resultRetentionMs: 24 * 60 * 60_000,
  normalJobs: 128,
  securityJobs: 64,
  managementResults: 4_096,
  bodyTransfers: 2,
  alarmBatch: 16,
  alarmBudgetMs: 5_000,
  allowlistEntries: 200,
  initializationAssets: MAX_ROOM_ASSETS_PER_GENERATION,
  jobBytes: 65_536,
} as const;

export const subjectSchema = z.string().min(1).max(128);
export const operationIdSchema = z.uuid();
export const authorityVersionSchema = z.int().positive();
export const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const emailKeySchema = z
  .email()
  .max(254)
  .refine((email) => email === email.trim().toLowerCase());
export function normalizeAccountEmail(email: string): string {
  return emailKeySchema.parse(email.trim().toLowerCase());
}
export const trustedIdentitySchema = z.strictObject({
  subject: subjectSchema,
  email: emailKeySchema,
  lifecycleVersion: authorityVersionSchema,
});
export type TrustedIdentity = z.infer<typeof trustedIdentitySchema>;

/** Signed by the login service; grants identity, never a room role. */
export const identityProofClaimsSchema = z.strictObject({
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  aud: z.literal("drawstuff-room-identity"),
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  jti: operationIdSchema,
  iat: z.int().nonnegative(),
  exp: z.int().positive(),
  roomId: roomIdSchema,
  identity: trustedIdentitySchema,
});
export type IdentityProofClaims = z.infer<typeof identityProofClaimsSchema>;

export const roomStateSchema = z.enum(["initializing", "ready", "ended"]);
export const linkRoleSchema = z.enum(["none", "viewer", "editor"]);
const memberRoleSchema = z.enum(["viewer", "editor"]);
const envelope = {
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  operationId: operationIdSchema,
  roomId: roomIdSchema,
  actor: trustedIdentitySchema,
  deadline: z.int().positive(),
};
export const initializationManifestSchema = z.strictObject({
  authGeneration: roomAuthGenerationSchema,
  revision: z.int().positive(),
  checksum: checksumSchema,
  assetIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
    .max(AUTHORITY_LIMITS.initializationAssets)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const roomCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...envelope,
    action: z.literal("create"),
    sceneId: z.uuid().nullable(),
    label: z.string().max(120),
    linkRole: linkRoleSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("join"),
    registrationVersion: authorityVersionSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("set-link-role"),
    linkRole: linkRoleSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("set-member-role"),
    subject: subjectSchema,
    role: memberRoleSchema,
    registrationVersion: authorityVersionSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("revoke-member"),
    subject: subjectSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("allow-email"),
    email: z.email().max(254),
    role: memberRoleSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("remove-email"),
    email: z.email().max(254),
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("rotate-generation"),
    expectedGeneration: roomAuthGenerationSchema,
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("set-key-check"),
    keyCheck: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength === KEYCHECK_CIPHERTEXT_BYTES),
  }),
  z.strictObject({
    ...envelope,
    action: z.literal("complete-initialization"),
    manifest: initializationManifestSchema,
  }),
  z.strictObject({ ...envelope, action: z.literal("cancel-initialization") }),
  z.strictObject({ ...envelope, action: z.literal("end-room") }),
]);
export type RoomCommand = z.infer<typeof roomCommandSchema>;

/** Authenticated entry input: actor and lifecycle versions are supplied only by trusted services. */
export const authorityRequestSchema = z.discriminatedUnion("action", [
  roomCommandSchema.options[0].omit({ actor: true }),
  roomCommandSchema.options[1].omit({ actor: true, registrationVersion: true }),
  roomCommandSchema.options[2].omit({ actor: true }),
  roomCommandSchema.options[3].omit({ actor: true, registrationVersion: true }),
  roomCommandSchema.options[4].omit({ actor: true }),
  roomCommandSchema.options[5].omit({ actor: true }),
  roomCommandSchema.options[6].omit({ actor: true }),
  roomCommandSchema.options[7].omit({ actor: true }),
  z
    .strictObject({
      ...envelope,
      action: z.literal("set-key-check"),
      keyCheck: z
        .array(z.int().min(0).max(255))
        .length(KEYCHECK_CIPHERTEXT_BYTES),
    })
    .omit({ actor: true }),
  roomCommandSchema.options[9].omit({ actor: true }),
  roomCommandSchema.options[10].omit({ actor: true }),
  roomCommandSchema.options[11].omit({ actor: true }),
  z
    .strictObject({ ...envelope, action: z.literal("get-state") })
    .omit({ actor: true }),
  z
    .strictObject({ ...envelope, action: z.literal("query") })
    .omit({ actor: true }),
]);
export type AuthorityRequest = z.infer<typeof authorityRequestSchema>;
export const AUTHORITY_GATEWAY_PATH = "/v1/authority";
export const authoritySocketPath = (roomId: string): string =>
  `/v1/rooms/${roomIdSchema.parse(roomId)}/socket`;
export const authorityGatewayRequestSchema = z.strictObject({
  proof: z.string().min(1).max(2_048),
  request: authorityRequestSchema,
});
export const authorityStateSchema = z.strictObject({
  roomId: roomIdSchema,
  state: roomStateSchema,
  role: roomRoleSchema,
  sceneId: z.uuid().nullable(),
  label: z.string().max(120),
  linkRole: linkRoleSchema,
  authGeneration: roomAuthGenerationSchema,
  authRevision: authorityVersionSchema,
  authorityEpoch: authorityVersionSchema,
  initializationDeadline: z.int().positive(),
});
export const registrationCommandSchema = z.strictObject({
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  action: z.literal("register"),
  operationId: operationIdSchema,
  roomId: roomIdSchema,
  identity: trustedIdentitySchema,
  ownerId: subjectSchema,
  sceneId: z.uuid().nullable(),
  create: z.boolean(),
  targetSubject: subjectSchema.optional(),
});
export const registrationReceiptSchema = z.strictObject({
  roomId: roomIdSchema,
  operationId: operationIdSchema,
  subject: subjectSchema,
  lifecycleVersion: authorityVersionSchema,
  targetSubject: subjectSchema.optional(),
  targetVersion: authorityVersionSchema.optional(),
});
export const createParentCommandSchema = z.strictObject({
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  action: z.literal("create-parent"),
  roomId: roomIdSchema,
  owner: trustedIdentitySchema,
  createOperationId: operationIdSchema,
  sceneId: z.uuid().nullable(),
  label: z.string().max(120),
  linkRole: linkRoleSchema,
  initializationDeadline: z.int().positive(),
});
export const parentReceiptSchema = z.strictObject({
  roomId: roomIdSchema,
  createOperationId: operationIdSchema,
});

export const contentOperationSchema = z
  .strictObject({
    ...envelope,
    kind: z.enum(["snapshot-put", "snapshot-reset", "asset-finalize"]),
    authGeneration: roomAuthGenerationSchema,
    authorityEpoch: authorityVersionSchema,
    expectedRevision: z.int().nonnegative(),
    checksum: checksumSchema,
    asset: z
      .strictObject({
        ...collaborationAssetRecordSchema.shape,
        utFileKey: z.string().min(1).max(256),
      })
      .optional(),
  })
  .refine(
    (operation) =>
      (operation.kind === "asset-finalize") === (operation.asset !== undefined),
    "asset-finalize requires an immutable asset descriptor",
  );
export type ContentOperation = z.infer<typeof contentOperationSchema>;
/** The login service supplies identity; callers only supply an immutable snapshot intent. */
const snapshotIntentSchema = z
  .strictObject(contentOperationSchema.shape)
  .omit({ actor: true, asset: true })
  .extend({ kind: z.enum(["snapshot-put", "snapshot-reset"]) });
export const snapshotRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.enum(["write", "query", "cancel"]),
    operation: snapshotIntentSchema,
  }),
  z.strictObject({
    action: z.literal("read"),
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    roomId: roomIdSchema,
    operationId: operationIdSchema,
    deadline: z.int().positive(),
  }),
]);
export const snapshotGatewayRequestSchema = z.strictObject({
  proof: z.string().min(1).max(2_048),
  request: snapshotRequestSchema,
});
export const SNAPSHOT_GATEWAY_PATH = "/v1/snapshot";
export const SNAPSHOT_REQUEST_HEADER = "x-drawstuff-snapshot-request";
export const SNAPSHOT_RECEIPT_HEADER = "x-drawstuff-snapshot";
export const storageCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("write"),
    operation: contentOperationSchema,
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.enum(["query", "cancel"]),
    operation: contentOperationSchema,
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("fence"),
    roomId: roomIdSchema,
    authorityEpoch: authorityVersionSchema,
  }),
]);
export const contentResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("written"),
    revision: z.int().positive(),
  }),
  z.strictObject({ status: z.enum(["cancelled", "refused", "conflict"]) }),
]);
export type ContentResult = z.infer<typeof contentResultSchema>;
export const authorityErrorSchema = z.enum([
  "not-found",
  "forbidden",
  "initializing",
  "ended",
  "stale-proof",
  "operation-mismatch",
  "expired-operation",
  "capacity",
  "generation-mismatch",
  "initialization-incomplete",
]);
export const managementResultSchema = z.strictObject({
  operationId: operationIdSchema,
  status: z.enum(["pending", "enforced", "cancelled"]),
  authRevision: authorityVersionSchema,
  authorityEpoch: authorityVersionSchema,
  projectionPending: z.boolean(),
  role: roomRoleSchema.optional(),
});
export type ManagementResult = z.infer<typeof managementResultSchema>;

export const authorityGatewayResponseSchema = z.strictObject({
  ok: z.literal(true),
  result: z.union([managementResultSchema, authorityStateSchema]),
});

export const projectionEventSchema = z.strictObject({
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  roomId: roomIdSchema,
  subject: subjectSchema,
  version: authorityVersionSchema,
  status: roomStateSchema,
  role: roomRoleSchema,
  tombstone: z.boolean(),
  label: z.string().max(120),
  sceneId: z.uuid().nullable(),
  // Stable sort key: changes to drawings do not update it.
  listedAt: z.int().nonnegative(),
});
export type ProjectionEvent = z.infer<typeof projectionEventSchema>;
/** Server-to-server adapter commands. Browser identity/roles are never sufficient to call these. */
const storageContext = {
  roomId: roomIdSchema,
  authGeneration: roomAuthGenerationSchema,
  authorityEpoch: authorityVersionSchema,
};
export const adapterCommandSchema = z.discriminatedUnion("action", [
  registrationCommandSchema,
  createParentCommandSchema,
  storageCommandSchema.options[0],
  storageCommandSchema.options[1],
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("fence"),
    ...storageContext,
    state: roomStateSchema,
    initializationDeadline: z.int().positive().optional(),
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("read-snapshot"),
    ...storageContext,
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("read-assets"),
    ...storageContext,
    assetIds: initializationManifestSchema.shape.assetIds,
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("verify-initialization"),
    ...storageContext,
    manifest: initializationManifestSchema,
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("cleanup"),
    ...storageContext,
  }),
  z.strictObject({
    v: z.literal(AUTHORITY_CONTRACT_VERSION),
    action: z.literal("project"),
    event: projectionEventSchema,
  }),
]);
export type AdapterCommand = z.infer<typeof adapterCommandSchema>;
export const ADAPTER_METADATA_HEADER = "x-drawstuff-adapter-command";
export const ADAPTER_METADATA_MAX_BYTES = 8_192;
export const snapshotReceiptSchema = z.strictObject({
  ...storageContext,
  revision: z.int().positive(),
  cryptoVersion: z.literal(1),
  byteLength: z.int().positive(),
  checksum: checksumSchema,
});
/** An absent snapshot still has a durable revision after reset. */
export const snapshotAbsenceReceiptSchema = z.strictObject({
  ...storageContext,
  revision: z.int().nonnegative(),
});
export const roomListInputSchema = z.strictObject({
  limit: z.int().min(1).max(100).default(30),
  cursor: z
    .strictObject({ listedAt: z.int().nonnegative(), roomId: roomIdSchema })
    .optional(),
});

export const lifecycleTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), subject: subjectSchema }),
  z.strictObject({
    kind: z.literal("scene"),
    subject: subjectSchema,
    sceneId: z.uuid(),
  }),
]);
export type LifecycleTarget = z.infer<typeof lifecycleTargetSchema>;
export function lifecycleObjectName(target: LifecycleTarget): string {
  return target.kind === "account"
    ? `account:${target.subject}`
    : `scene:${target.sceneId}`;
}
export const lifecycleCommandSchema = z.strictObject({
  v: z.literal(AUTHORITY_CONTRACT_VERSION),
  operationId: operationIdSchema,
  actor: subjectSchema,
  target: lifecycleTargetSchema,
});
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;
export const lifecyclePhaseSchema = z.enum([
  "freezing",
  "enumerating",
  "enforcing",
  "deleting",
  "completed",
]);
export const lifecyclePageSchema = z.strictObject({
  version: authorityVersionSchema,
  rooms: z
    .array(
      z.strictObject({
        roomId: roomIdSchema,
        action: z.enum(["end-room", "revoke-member"]),
      }),
    )
    .max(AUTHORITY_LIMITS.alarmBatch),
  cursor: z.string().max(256).nullable(),
});
export const durableJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create-parent"),
    command: createParentCommandSchema,
  }),
  z.strictObject({
    kind: z.literal("projection"),
    event: projectionEventSchema,
  }),
  z.strictObject({
    kind: z.literal("fence"),
    roomId: roomIdSchema,
    authorityEpoch: authorityVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("settle-content"),
    operation: contentOperationSchema,
  }),
  z.strictObject({
    kind: z.literal("initialize"),
    roomId: roomIdSchema,
    operationId: operationIdSchema,
    manifest: initializationManifestSchema,
  }),
  z.strictObject({
    kind: z.literal("cleanup"),
    roomId: roomIdSchema,
    operationId: operationIdSchema,
  }),
  z.strictObject({
    kind: z.literal("retire"),
    command: lifecycleCommandSchema,
  }),
]);
export type DurableJob = z.infer<typeof durableJobSchema>;
