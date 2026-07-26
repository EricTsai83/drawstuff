import "server-only";

import { env } from "@/env";
import {
  evaluateWhiteboardRollout,
  type WhiteboardRolloutDecision,
} from "@/features/whiteboard";

export function resolveServerWhiteboardRollout(target: {
  readonly subjectId?: string;
  readonly email?: string;
}): WhiteboardRolloutDecision {
  return evaluateWhiteboardRollout(
    {
      enabled: env.WHITEBOARD_ENGINE_ENABLED === "true",
      rollback: env.WHITEBOARD_ENGINE_ROLLBACK === "true",
      percentage: env.WHITEBOARD_ENGINE_PERCENTAGE,
      internalEmails: commaSeparatedSet(
        env.WHITEBOARD_ENGINE_INTERNAL_EMAILS,
        true,
      ),
      forceOwnedSubjectIds: commaSeparatedSet(
        env.WHITEBOARD_ENGINE_FORCE_OWNED_SUBJECTS,
      ),
      forceLegacySubjectIds: commaSeparatedSet(
        env.WHITEBOARD_ENGINE_FORCE_LEGACY_SUBJECTS,
      ),
    },
    target,
  );
}

function commaSeparatedSet(value: string, lowercase = false): Set<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (lowercase ? entry.toLowerCase() : entry)),
  );
}
