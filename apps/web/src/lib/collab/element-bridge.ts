import type { PeerId, SyncedElement } from "@drawstuff/collaboration/protocol";
import type {
  ExcalidrawElement,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

/**
 * The single place the collaboration protocol's types meet Excalidraw's.
 *
 * Every conversion here is an identity at runtime — the same object is handed
 * back under a different type — and each is trusted for one reason:
 *
 * - `SyncedElement` is a loose zod object that pins only the identity fields
 *   reconciliation reads (`id`, `version`, `versionNonce`, `isDeleted`); the
 *   rest of the element body is engine-owned and travels unprojected, exactly
 *   like scene persistence (see packages/collaboration/src/messages.ts). Every
 *   element the canvas hands out has those fields, and every element the codec
 *   admits was produced by a peer's canvas, so the two types describe the same
 *   values. The cast exists only because zod's inferred index signature and
 *   Excalidraw's discriminated union do not structurally overlap.
 *
 * - `PeerId` and `SocketId` are both branded strings naming one connected
 *   client; the session uses the relay's peer id as Excalidraw's socket id.
 *
 * Keeping the casts here means the rest of the session code type-checks against
 * honest signatures and never spells `as unknown as` itself.
 */

/**
 * Canvas elements viewed as protocol elements. Returned mutable only because
 * zod infers `z.array` payloads as mutable arrays; nothing mutates the result.
 */
export const toSyncedElements = (
  elements: readonly ExcalidrawElement[],
): SyncedElement[] => elements as unknown as SyncedElement[];

/** Protocol elements viewed as canvas elements, for the reconciliation input. */
export const toExcalidrawElements = (
  elements: readonly SyncedElement[],
): readonly ExcalidrawElement[] =>
  elements as unknown as readonly ExcalidrawElement[];

export const toSocketId = (peerId: PeerId): SocketId =>
  peerId as unknown as SocketId;

export const toSocketIds = (peerIds: readonly PeerId[]): readonly SocketId[] =>
  peerIds as unknown as readonly SocketId[];
