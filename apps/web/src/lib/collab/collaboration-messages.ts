import type { SceneSyncBlock } from "@/lib/collab/collaboration-session";
import type { CollaborationFailureReason } from "@/lib/collab/room-state-reducer";
import type { AppTranslate, AppTranslationKey } from "@/lib/i18n";

/**
 * The user-facing wording for every way a collaboration session can stop or
 * degrade. Pure key selection and formatting — no React — so the mapping can be
 * tested and audited in one place.
 */

/**
 * What each terminal recovery reason means for the user, and what they can do
 * about it. Every reason gets a message: an unexplained "stopped reconnecting" is
 * indistinguishable from a hang, and the action differs per reason — ask for
 * access, go back to your own canvas, or reload.
 */
export const FAILURE_MESSAGE_KEY: Record<
  CollaborationFailureReason,
  AppTranslationKey
> = {
  unauthorized: "collaboration.failure.unauthorized",
  // The account has no access to this room (plan 21 §6).
  "no-access": "collaboration.failure.noAccess",
  "room-ended": "collaboration.failure.roomEnded",
  "protocol-violation": "collaboration.failure.protocolViolation",
  // Not the protocol-violation wording: an outdated tab is repaired by a
  // reload, and telling its user to report a bug would send them away from
  // the one action that fixes it.
  "unsupported-protocol-version":
    "collaboration.failure.unsupportedProtocolVersion",
  "retry-limit": "collaboration.failure.retryLimit",
};

/**
 * The shared join budget refused this client for longer than the bounded wait.
 *
 * Says "later", not "no". The previous behaviour reported this through the
 * catch-all as `unauthorized`, which reads as a permissions problem — and the
 * one thing a user does about that is ask for access they already have, or
 * reload, which spends more of the very budget they are waiting on.
 */
export const JOIN_RATE_LIMITED_MESSAGE_KEY =
  "collaboration.failure.rateLimited";

/**
 * The bootstrap join failed for a reason worth retrying. Deliberately a
 * translated, generic message rather than the thrown `error.message`: what
 * lands here ranges from a fetch that never left the machine to a backend
 * error, none of which a raw message explains — and several of which would
 * previously masquerade as an authorization problem.
 */
export const JOIN_RETRYABLE_MESSAGE_KEY = "collaboration.failure.joinFailed";

/**
 * What a damaged room image means, and what the user can actually do.
 *
 * Deliberately not a failure, because the situation is weaker: the elements still sync, the session is healthy, and
 * only the pictures are missing. Stating that keeps the user from reading a
 * partly-loaded canvas as a broken one.
 */
export const UNREADABLE_ASSETS_MESSAGE_KEY =
  "collaboration.warning.unreadableAssets";

const BYTES_PER_MIB = 1_048_576;

const toMib = (bytes: number): string =>
  `${(bytes / BYTES_PER_MIB).toFixed(1)} MB`;

/**
 * What an oversize canvas means, per blocked path, and the one action that fixes
 * it.
 *
 * Both halves are stated because a canvas can breach one contract without the
 * other, and the consequences are different things to lose: realtime is what the
 * other members stop receiving, durable is what a reload or a later joiner stops
 * seeing. Exporting locally leads, the way it does upstream, because it is the
 * only step that is guaranteed to work — "wait" is precisely what does not.
 *
 * Shrinking the canvas is offered with its real caveat rather than as a promise.
 * A deleted element keeps flowing through sync as a tombstone for
 * `DELETED_ELEMENT_SYNC_TIMEOUT_MS`, body included, so deleting content does not
 * immediately reduce the payload; a reload starts from the compacted scene and
 * does. Saying "just delete something" would be advice that visibly fails.
 *
 * Deliberately not a toast. This condition persists until the user acts on it, so
 * it lives in the room status (`sync-blocked`) and this message, both of which
 * stay on screen; a notification that fires once would be gone before the user
 * finished the edit that caused it.
 */
export function sceneSyncBlockMessage(
  block: SceneSyncBlock,
  t: AppTranslate,
): string {
  const parts: string[] = [];
  if (block.realtime) {
    parts.push(
      t("collaboration.warning.realtimeTooLarge", {
        size: toMib(block.realtime.byteLength),
        limit: toMib(block.realtime.maxByteLength),
      }),
    );
  }
  if (block.durable) {
    parts.push(
      t("collaboration.warning.backupTooLarge", {
        size: toMib(block.durable.byteLength),
        limit: toMib(block.durable.maxByteLength),
      }),
    );
  }
  parts.push(t("collaboration.warning.tooLargeAdvice"));
  return parts.join(" ");
}
