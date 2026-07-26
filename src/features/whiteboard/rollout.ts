export type WhiteboardEngineKind = "excalidraw" | "owned";

export type WhiteboardRolloutReason =
  | "disabled"
  | "explicit-owned"
  | "explicit-rollback"
  | "global-rollback"
  | "internal"
  | "percentage"
  | "percentage-miss"
  | "unsigned";

export interface WhiteboardRolloutConfig {
  readonly enabled: boolean;
  readonly rollback: boolean;
  readonly percentage: number;
  readonly internalEmails: ReadonlySet<string>;
  readonly forceOwnedSubjectIds: ReadonlySet<string>;
  readonly forceLegacySubjectIds: ReadonlySet<string>;
}

export interface WhiteboardRolloutTarget {
  readonly subjectId?: string;
  readonly email?: string;
}

export interface WhiteboardRolloutDecision {
  readonly engine: WhiteboardEngineKind;
  readonly reason: WhiteboardRolloutReason;
  readonly documentVersion: 1;
}

export function evaluateWhiteboardRollout(
  config: WhiteboardRolloutConfig,
  target: WhiteboardRolloutTarget,
): WhiteboardRolloutDecision {
  const legacy = (reason: WhiteboardRolloutReason) =>
    ({
      engine: "excalidraw",
      reason,
      documentVersion: 1,
    }) as const;
  const owned = (reason: WhiteboardRolloutReason) =>
    ({
      engine: "owned",
      reason,
      documentVersion: 1,
    }) as const;

  if (config.rollback) return legacy("global-rollback");
  if (target.subjectId && config.forceLegacySubjectIds.has(target.subjectId)) {
    return legacy("explicit-rollback");
  }
  if (target.subjectId && config.forceOwnedSubjectIds.has(target.subjectId)) {
    return owned("explicit-owned");
  }
  if (!config.enabled) return legacy("disabled");

  const normalizedEmail = target.email?.trim().toLowerCase();
  if (normalizedEmail && config.internalEmails.has(normalizedEmail)) {
    return owned("internal");
  }
  if (!target.subjectId) return legacy("unsigned");

  return stablePercentageBucket(target.subjectId) < config.percentage
    ? owned("percentage")
    : legacy("percentage-miss");
}

/**
 * FNV-1a produces a deterministic 0–99 bucket without storing identifiers.
 * The cohort therefore remains stable across refreshes and server instances.
 */
export function stablePercentageBucket(subjectId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < subjectId.length; index += 1) {
    hash ^= subjectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}
