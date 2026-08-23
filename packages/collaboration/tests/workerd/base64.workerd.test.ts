import { afterEach, describe, expect, it } from "vitest";

import {
  decodeBase64,
  decodeBase64Url,
  encodeBase64,
  encodeBase64Url,
  forceBase64ImplementationForTesting,
} from "../../src/base64.ts";
import {
  BASE64_VECTORS,
  hostHasNativeBase64,
  MALFORMED_BASE64,
  MALFORMED_BASE64URL,
  referenceBase64Encode,
  seededBytes,
} from "../base64-vectors.ts";

/**
 * The same canonical-profile vectors the Node/Chromium/WebKit projects run,
 * executed inside workerd. Correctness and import-contract coverage only —
 * this project makes no claim about Durable Object lifecycle or load.
 */

const implementations: ReadonlyArray<"native" | "fallback"> =
  hostHasNativeBase64() ? ["native", "fallback"] : ["fallback"];

afterEach(() => {
  forceBase64ImplementationForTesting(null);
});

describe.each(implementations)(
  "base64 codec in workerd (%s path)",
  (implementation) => {
    const use = () => forceBase64ImplementationForTesting(implementation);

    it("matches the fixed vectors in both directions", () => {
      use();
      for (const vector of BASE64_VECTORS) {
        const bytes = Uint8Array.from(vector.bytes);
        expect(encodeBase64(bytes)).toBe(vector.base64);
        expect(encodeBase64Url(bytes)).toBe(vector.base64url);
        expect(decodeBase64(vector.base64, { maxBytes: 1_024 })).toEqual({
          ok: true,
          bytes,
        });
        expect(decodeBase64Url(vector.base64url, { maxBytes: 1_024 })).toEqual({
          ok: true,
          bytes,
        });
      }
    });

    it("agrees with the reference encoder across the byte range and chunk boundary", () => {
      use();
      for (const size of [256, 8_191, 8_192, 8_193]) {
        const bytes =
          size === 256
            ? Uint8Array.from({ length: 256 }, (_, index) => index)
            : seededBytes(size, 0xd7a05f + size);
        const standard = encodeBase64(bytes);
        expect(standard).toBe(
          referenceBase64Encode(bytes, { alphabet: "base64" }),
        );
        const decoded = decodeBase64(standard, { maxBytes: size });
        expect(decoded.ok && decoded.bytes).toEqual(bytes);
        expect(encodeBase64Url(bytes)).toBe(
          referenceBase64Encode(bytes, { alphabet: "base64url" }),
        );
      }
    });

    it.each(MALFORMED_BASE64)(
      "rejects malformed standard input %j",
      (value) => {
        use();
        expect(decodeBase64(value, { maxBytes: 1_024 })).toEqual({
          ok: false,
          reason: "malformed",
        });
      },
    );

    it.each(MALFORMED_BASE64URL)("rejects malformed url input %j", (value) => {
      use();
      expect(decodeBase64Url(value, { maxBytes: 1_024 })).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it("refuses oversize input from its encoded length", () => {
      use();
      expect(decodeBase64("AAAA", { maxBytes: 2 })).toEqual({
        ok: false,
        reason: "oversize",
      });
      expect(decodeBase64Url("AAA", { maxBytes: 1 })).toEqual({
        ok: false,
        reason: "oversize",
      });
    });
  },
);
