import { z } from "zod";

export const whiteboardDiagnosticSchema = z
  .object({
    operation: z.enum(["asset", "export", "load", "render", "save"]),
    outcome: z.enum(["blocked", "failure", "success"]),
    documentVersion: z.number().int().nonnegative().nullable(),
    errorCode: z
      .enum([
        "CONFLICT",
        "INVALID_DOCUMENT",
        "LEGACY_SHARE_EXPIRED",
        "MISSING_ASSET",
        "NETWORK",
        "PAYLOAD_TOO_LARGE",
        "UNKNOWN",
      ])
      .optional(),
  })
  .strict();

export type WhiteboardDiagnostic = z.infer<typeof whiteboardDiagnosticSchema>;

export function recordWhiteboardDiagnostic(
  diagnostic: WhiteboardDiagnostic,
): void {
  if (typeof window === "undefined") return;
  const parsed = whiteboardDiagnosticSchema.safeParse(diagnostic);
  if (!parsed.success) return;

  void fetch("/api/whiteboard-diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed.data),
    keepalive: true,
  }).catch(() => {
    // Diagnostics must never interrupt editing or local persistence.
  });
}
