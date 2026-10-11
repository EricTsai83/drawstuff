// @vitest-environment node
import { TRPCError } from "@trpc/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/server/db", () => ({ db: {} }));
const signals = vi.hoisted(() => [] as string[]);
vi.mock("@/server/ops/settings", () => ({
  recordOpsSignal: async (name: string) => {
    signals.push(name);
  },
}));
const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; session: { id: string } },
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => auth.session,
}));
vi.mock("@/server/quota", () => ({
  assertWithinQuota: async () => undefined,
  QuotaExceededError: class extends Error {},
}));
const prepare = vi.hoisted((): { error: unknown } => ({ error: undefined }));
vi.mock("@/server/collab/asset-authority", () => ({
  prepareAuthorityAssetUpload: async () => {
    throw prepare.error;
  },
  finalizeAuthorityAssetUpload: async () => undefined,
}));

const { AdapterError } = await import("@/server/collab/authority-storage");
const { reportPresignFailure } =
  await import("@/app/api/uploadthing/presign-failure");
const { uploadRouter } = await import("@/app/api/uploadthing/core");

/**
 * A failed collaboration presign used to be a bare UploadThing 500 with no
 * application log, so its cause could not be told apart from any other 500.
 * These pin the replacement: one closed-schema line per failure, naming where
 * the middleware was and which of the app's own errors it raised — and never
 * anything the error carries.
 */

let warn: MockInstance<typeof console.warn>;
const records = (): unknown[] =>
  warn.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown);

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  signals.length = 0;
});
afterEach(() => {
  warn.mockRestore();
});

describe("presign failure record", () => {
  it("names the app's own error codes", () => {
    reportPresignFailure(
      "authority",
      new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "secret detail" }),
    );
    reportPresignFailure("authority", new AdapterError("fence-mismatch"));
    expect(records()).toEqual([
      {
        event: "collab.asset_presign.failed",
        stage: "authority",
        errorName: "TRPCError",
        code: "SERVICE_UNAVAILABLE",
      },
      {
        event: "collab.asset_presign.failed",
        stage: "authority",
        errorName: "AdapterError",
        code: "fence-mismatch",
      },
    ]);
    expect(signals).toEqual([
      "asset-presign.failed:authority",
      "asset-presign.failed:authority",
    ]);
  });

  it("never carries the message, a writable name or a foreign code", () => {
    const named = new Error("https://example.test/?token=secret");
    named.name = "token=secret";
    const coded = new TypeError("boom");
    Object.assign(coded, { code: "token=secret" });
    const tampered = new TRPCError({ code: "FORBIDDEN" });
    Object.assign(tampered, { code: "secretTokenFragment" });
    const adapter = new AdapterError("not-found");
    Object.assign(adapter, { code: "secret-token-fragment" });
    reportPresignFailure("authority", tampered);
    reportPresignFailure("authority", adapter);
    reportPresignFailure("session", named);
    reportPresignFailure("quota", coded);
    reportPresignFailure("quota", "a thrown string with payload");
    expect(records()).toEqual([
      {
        event: "collab.asset_presign.failed",
        stage: "authority",
        errorName: "TRPCError",
      },
      {
        event: "collab.asset_presign.failed",
        stage: "authority",
        errorName: "AdapterError",
      },
      {
        event: "collab.asset_presign.failed",
        stage: "session",
        errorName: "Error",
      },
      {
        event: "collab.asset_presign.failed",
        stage: "quota",
        errorName: "TypeError",
      },
      {
        event: "collab.asset_presign.failed",
        stage: "quota",
        errorName: "string",
      },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });
});

describe("collaboration asset presign middleware", () => {
  const middleware = (
    uploadRouter.collaborationAssetUploader as unknown as {
      middleware: (options: {
        input: unknown;
        req: Request;
        files: readonly { size: number }[];
      }) => Promise<unknown>;
    }
  ).middleware;
  const call = () =>
    middleware({
      input: {},
      req: new Request("https://app.test/api/uploadthing"),
      files: [{ size: 1 }],
    });

  it("records a missing session at the session stage and still refuses", async () => {
    auth.session = null;
    await expect(call()).rejects.toThrow("Unauthorized");
    expect(records()).toEqual([
      {
        event: "collab.asset_presign.failed",
        stage: "session",
        errorName: "Error",
      },
    ]);
  });

  it("records an authority failure and rethrows the same error", async () => {
    auth.session = { user: { id: "user-1" }, session: { id: "session-1" } };
    const error = new TRPCError({ code: "SERVICE_UNAVAILABLE" });
    prepare.error = error;
    await expect(call()).rejects.toBe(error);
    expect(records()).toEqual([
      {
        event: "collab.asset_presign.failed",
        stage: "authority",
        errorName: "TRPCError",
        code: "SERVICE_UNAVAILABLE",
      },
    ]);
  });
});
