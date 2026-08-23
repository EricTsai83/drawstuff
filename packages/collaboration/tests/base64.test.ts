import { afterEach, describe, expect, it } from "vitest";

import {
  decodeBase64,
  decodeBase64Url,
  encodeBase64,
  encodeBase64Url,
  forceBase64ImplementationForTesting,
} from "../src/base64.ts";
import {
  BASE64_VECTORS,
  hostHasNativeBase64,
  MALFORMED_BASE64,
  MALFORMED_BASE64URL,
  referenceBase64Encode,
  seededBytes,
} from "./base64-vectors.ts";

/**
 * The shared Base64/Base64URL codec (Plan 08): one canonical profile per
 * format on every host. This suite runs unchanged in Node, Chromium, and
 * WebKit (and its vectors again in workerd), over both the native TypedArray
 * path and the chunked fallback, so a host decoder's leniency can never leak
 * through an entry point.
 */

const nativeAvailable = hostHasNativeBase64();

const implementations: ReadonlyArray<"native" | "fallback"> = nativeAvailable
  ? ["native", "fallback"]
  : ["fallback"];

/** Payload sizes around the fallback's 8 KiB chunk boundary, plus 4 MiB. */
const CHUNK_BOUNDARY_SIZES = [8_191, 8_192, 8_193] as const;
const LARGE_PAYLOAD_BYTES = 4 * 1_048_576;
const FIXTURE_SEED = 0xd7a05f;

afterEach(() => {
  forceBase64ImplementationForTesting(null);
});

describe.each(implementations)("base64 codec (%s path)", (implementation) => {
  const use = () => forceBase64ImplementationForTesting(implementation);

  it("matches the fixed vectors in both directions", () => {
    use();
    for (const vector of BASE64_VECTORS) {
      const bytes = Uint8Array.from(vector.bytes);
      expect(encodeBase64(bytes)).toBe(vector.base64);
      expect(encodeBase64Url(bytes)).toBe(vector.base64url);
      const standard = decodeBase64(vector.base64, { maxBytes: 1_024 });
      expect(standard).toEqual({ ok: true, bytes });
      const url = decodeBase64Url(vector.base64url, { maxBytes: 1_024 });
      expect(url).toEqual({ ok: true, bytes });
    }
  });

  it("re-encoding a decoded value reproduces the input character-for-character", () => {
    use();
    // The canonical-profile contract: decode ∘ encode is the identity on every
    // accepted input. Verified here over all vectors (production decode never
    // re-encodes; this equivalence is guaranteed structurally by the guards).
    for (const vector of BASE64_VECTORS) {
      const standard = decodeBase64(vector.base64, { maxBytes: 1_024 });
      if (!standard.ok) throw new Error("vector must decode");
      expect(encodeBase64(standard.bytes)).toBe(vector.base64);
      const url = decodeBase64Url(vector.base64url, { maxBytes: 1_024 });
      if (!url.ok) throw new Error("vector must decode");
      expect(encodeBase64Url(url.bytes)).toBe(vector.base64url);
    }
  });

  it("round-trips the full 0-255 byte range and agrees with the reference encoder", () => {
    use();
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const standard = encodeBase64(bytes);
    const url = encodeBase64Url(bytes);
    expect(standard).toBe(referenceBase64Encode(bytes, { alphabet: "base64" }));
    expect(url).toBe(referenceBase64Encode(bytes, { alphabet: "base64url" }));
    expect(decodeBase64(standard, { maxBytes: 256 })).toEqual({
      ok: true,
      bytes,
    });
    expect(decodeBase64Url(url, { maxBytes: 256 })).toEqual({
      ok: true,
      bytes,
    });
  });

  it.each(CHUNK_BOUNDARY_SIZES)(
    "handles the %i-byte fallback chunk boundary",
    (size) => {
      use();
      const bytes = seededBytes(size, FIXTURE_SEED + size);
      const standard = encodeBase64(bytes);
      expect(standard).toBe(
        referenceBase64Encode(bytes, { alphabet: "base64" }),
      );
      const decoded = decodeBase64(standard, { maxBytes: size });
      expect(decoded.ok && decoded.bytes).toEqual(bytes);
      const url = encodeBase64Url(bytes);
      expect(url).toBe(referenceBase64Encode(bytes, { alphabet: "base64url" }));
      const decodedUrl = decodeBase64Url(url, { maxBytes: size });
      expect(decodedUrl.ok && decodedUrl.bytes).toEqual(bytes);
    },
  );

  it("round-trips a deterministic 4 MiB payload", { timeout: 30_000 }, () => {
    use();
    const bytes = seededBytes(LARGE_PAYLOAD_BYTES, FIXTURE_SEED);
    const encoded = encodeBase64(bytes);
    const decoded = decodeBase64(encoded, { maxBytes: LARGE_PAYLOAD_BYTES });
    if (!decoded.ok) throw new Error("4 MiB payload must decode");
    // Element loop rather than deep-equality matcher: the matcher walks 4M
    // entries through its diff machinery and times the test out.
    expect(decoded.bytes.byteLength).toBe(bytes.byteLength);
    expect(decoded.bytes.every((byte, index) => byte === bytes[index])).toBe(
      true,
    );
    // Character-identical re-encode closes the canonical loop at full size.
    expect(encodeBase64(decoded.bytes)).toBe(encoded);
  });

  it.each(MALFORMED_BASE64)("rejects malformed standard input %j", (value) => {
    use();
    expect(decodeBase64(value, { maxBytes: 1_024 })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it.each(MALFORMED_BASE64URL)("rejects malformed url input %j", (value) => {
    use();
    expect(decodeBase64Url(value, { maxBytes: 1_024 })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses an oversize value from its encoded length alone", () => {
    use();
    // 4 encoded chars claim 3 bytes; a 2-byte bound refuses before decoding.
    expect(decodeBase64("AAAA", { maxBytes: 2 })).toEqual({
      ok: false,
      reason: "oversize",
    });
    expect(decodeBase64("AAAAAAAA", { maxBytes: 5 })).toEqual({
      ok: false,
      reason: "oversize",
    });
    expect(decodeBase64Url("AAAA", { maxBytes: 2 })).toEqual({
      ok: false,
      reason: "oversize",
    });
    expect(decodeBase64Url("AAA", { maxBytes: 1 })).toEqual({
      ok: false,
      reason: "oversize",
    });
    // The encoded-length gate runs before the O(n) body scan, so an input
    // that is both oversize and malformed reports `oversize` — the cheap
    // verdict an attacker-sized payload must get without being scanned.
    expect(decodeBase64("Zg==Zg==", { maxBytes: 1 })).toEqual({
      ok: false,
      reason: "oversize",
    });
    expect(decodeBase64Url("Zg==", { maxBytes: 1 })).toEqual({
      ok: false,
      reason: "oversize",
    });
    // Exactly at the bound is fine, including the empty canonical encoding.
    expect(decodeBase64("AAAA", { maxBytes: 3 }).ok).toBe(true);
    expect(decodeBase64("", { maxBytes: 0 })).toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
    expect(decodeBase64Url("", { maxBytes: 0 })).toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
  });

  it("treats an invalid maxBytes as a programmer error, not a decode result", () => {
    use();
    expect(() => decodeBase64("AAAA", { maxBytes: -1 })).toThrow(/maxBytes/);
    expect(() => decodeBase64("AAAA", { maxBytes: 1.5 })).toThrow(/maxBytes/);
    expect(() => decodeBase64Url("AAAA", { maxBytes: Number.NaN })).toThrow(
      /maxBytes/,
    );
  });
});

describe("implementation selection", () => {
  it.skipIf(!nativeAvailable)(
    "native and fallback paths produce identical output",
    () => {
      const sizes = [0, 1, 2, 3, 31, 8_191, 8_192, 8_193, 65_537];
      for (const size of sizes) {
        const bytes = seededBytes(size, FIXTURE_SEED ^ size);
        forceBase64ImplementationForTesting("native");
        const nativeStandard = encodeBase64(bytes);
        const nativeUrl = encodeBase64Url(bytes);
        forceBase64ImplementationForTesting("fallback");
        expect(encodeBase64(bytes)).toBe(nativeStandard);
        expect(encodeBase64Url(bytes)).toBe(nativeUrl);
        const viaFallback = decodeBase64(nativeStandard, { maxBytes: size });
        forceBase64ImplementationForTesting("native");
        const viaNative = decodeBase64(nativeStandard, { maxBytes: size });
        expect(viaFallback).toEqual(viaNative);
        expect(viaNative.ok && viaNative.bytes).toEqual(bytes);
      }
    },
  );

  it("falls back when the native API is missing instead of failing at import time", () => {
    // The module is already imported, so what is testable is the per-call
    // property: with the methods gone, every operation still works via the
    // fallback and forcing the native path is refused.
    const proto = Uint8Array.prototype as { toBase64?: unknown };
    const ctor = Uint8Array as { fromBase64?: unknown };
    const savedToBase64 = proto.toBase64;
    const savedFromBase64 = ctor.fromBase64;
    delete proto.toBase64;
    delete ctor.fromBase64;
    try {
      const bytes = Uint8Array.from([0x66, 0x6f, 0x6f]);
      expect(encodeBase64(bytes)).toBe("Zm9v");
      expect(encodeBase64Url(Uint8Array.from([0xfb]))).toBe("-w");
      expect(decodeBase64("Zm9v", { maxBytes: 3 })).toEqual({
        ok: true,
        bytes,
      });
      expect(decodeBase64Url("Zm9v", { maxBytes: 3 })).toEqual({
        ok: true,
        bytes,
      });
      expect(() => forceBase64ImplementationForTesting("native")).toThrow(
        /native/i,
      );
    } finally {
      if (savedToBase64 !== undefined) proto.toBase64 = savedToBase64;
      if (savedFromBase64 !== undefined) ctor.fromBase64 = savedFromBase64;
    }
  });
});
