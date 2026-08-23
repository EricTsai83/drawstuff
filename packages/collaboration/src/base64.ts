/**
 * Shared Base64 / Base64URL codec for every collaboration text boundary:
 * share-link room keys, the room key-check value, join/control tokens, and
 * durable snapshot ciphertext travelling through tRPC.
 *
 * This module is the wire-format precontract for the Durable Object relay
 * series: the same canonical semantics must hold in browsers, Vercel's Node
 * runtime, and Cloudflare workerd, so no host decoder's leniency (`atob`'s
 * forgiving-base64, `Buffer`'s garbage tolerance, native `fromBase64`'s
 * whitespace skipping) is allowed to decide what an entry point accepts. Each
 * format has exactly one canonical profile:
 *
 * - Standard Base64 (`A-Z a-z 0-9 + /`) with RFC 4648 canonical padding — no
 *   whitespace, no misplaced or excess padding, no truncated quantum, and the
 *   unused bits of a padded final quantum must be zero.
 * - Base64URL (`A-Z a-z 0-9 - _`), always unpadded — no `=`, no whitespace,
 *   no `length % 4 === 1`, and the unused trailing bits must be zero.
 * - The empty string is the canonical encoding of the empty byte sequence.
 *
 * Together those rules make decode-then-encode the identity on every accepted
 * input. That equivalence is verified exhaustively in tests over both
 * implementations; production decode never re-encodes (a second multi-megabyte
 * pass would double the cost of the 4 MiB snapshot hot path).
 *
 * The codec is deliberately pure: it reads no room, key, or scene state and
 * imports nothing — only ECMAScript / Web Platform primitives — so it is safe
 * to load in browsers, Node, and workerd alike.
 */

export type Base64DecodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "malformed" | "oversize" };

export type Base64DecodeOptions = {
  /**
   * Hard upper bound on the decoded byte length. Checked against the encoded
   * length before any allocation, and against the produced bytes after, so an
   * oversize payload is never materialized first and measured second.
   */
  maxBytes: number;
};

/**
 * Structural views of the TC39 TypedArray Base64 API
 * (https://tc39.es/proposal-arraybuffer-base64/spec/). Narrow on purpose: the
 * repo's TypeScript `lib` target stays put and no global declaration changes.
 */
type NativeToBase64 = (options?: {
  alphabet?: "base64" | "base64url";
  omitPadding?: boolean;
}) => string;
type NativeFromBase64 = (
  value: string,
  options?: {
    alphabet?: "base64" | "base64url";
    lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
  },
) => Uint8Array;

/**
 * Detected per call rather than at import time so a host without the native
 * API loads this module fine and simply takes the fallback, and so tests can
 * exercise the no-native path by removing the methods.
 */
const nativeBase64Available = (): boolean =>
  typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 ===
    "function" &&
  typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === "function";

/**
 * Test-only override. Production capability selection takes no caller option —
 * call sites choosing their own path would be a second behaviour — so the only
 * way to force one is this module-level switch, set exclusively from tests.
 */
let forcedImplementationForTesting: "native" | "fallback" | null = null;

export function forceBase64ImplementationForTesting(
  implementation: "native" | "fallback" | null,
): void {
  if (implementation === "native" && !nativeBase64Available()) {
    throw new Error(
      "Cannot force the native Base64 path: this host has no TypedArray Base64 API",
    );
  }
  forcedImplementationForTesting = implementation;
}

const useNativeBase64 = (): boolean =>
  forcedImplementationForTesting === null
    ? nativeBase64Available()
    : forcedImplementationForTesting === "native";

/**
 * 8 KiB fallback chunk: two orders of magnitude under every engine's
 * argument-count ceiling (~65k), while a 4 MiB payload still needs only 512
 * `fromCharCode` calls — never per-byte string concatenation.
 */
const FALLBACK_CHUNK_BYTES = 8192;

const toBinaryString = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += FALLBACK_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + FALLBACK_CHUNK_BYTES),
    );
  }
  return binary;
};

const STANDARD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Shape guards. These run before either implementation and reject whitespace
 * and misplaced padding themselves: native `fromBase64` skips ASCII whitespace
 * by specification, so leniency there cannot be leaned on. They are built from
 * a single small-class regex probe rather than a full-alphabet match, which on
 * a 4 MiB snapshot costs several times the decode itself and would break the
 * fallback's performance budget.
 *
 * What the standard-profile guard deliberately leaves to the host decoders is
 * one case both implement identically and strictly — a non-whitespace,
 * non-`=` character outside the standard alphabet ends `atob`
 * (forgiving-base64) and `fromBase64` alike in an exception, which this codec
 * maps to `malformed`. The post-decode byte-length equality check then pins
 * the produced bytes to the length the encoded form promised, so no host
 * leniency can leak through even if a host deviated. Base64URL input instead
 * gets the full alphabet match: its values are token-sized, and the fallback
 * decodes them by translating into the standard alphabet, which would
 * otherwise let `+` and `/` masquerade as URL characters.
 */
const BASE64URL_BODY = /^[A-Za-z0-9_-]*$/;

/**
 * ASCII whitespace (the set forgiving-base64 and native `fromBase64` skip)
 * plus `=`, neither of which may appear in a standard-profile body.
 */
const STANDARD_BODY_REJECT = /[\t\n\f\r =]/;

/**
 * A padded (or short) final quantum leaves 2 or 4 low bits of its last data
 * character outside the decoded bytes; canonically they are zero. Checking
 * them here — one O(64) `indexOf` on one character — is what lets production
 * decode skip a full re-encode comparison.
 */
const unusedBitsAreZero = (
  body: string,
  alphabet: string,
  mask: number,
): boolean => {
  const lastChar = body[body.length - 1];
  if (lastChar === undefined) return false;
  const value = alphabet.indexOf(lastChar);
  return value >= 0 && (value & mask) === 0;
};

const assertMaxBytes = (maxBytes: number): number => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(
      `maxBytes must be a non-negative safe integer, received ${maxBytes}`,
    );
  }
  return maxBytes;
};

/** Completes an unpadded value so native strict decoding accepts it. */
const padBase64Url = (value: string): string => {
  const remainder = value.length % 4;
  if (remainder === 2) return `${value}==`;
  if (remainder === 3) return `${value}=`;
  return value;
};

/**
 * Decodes a shape-guarded value. `null` means the host decoder refused input
 * the guard admitted, which callers report as `malformed`; the guard is the
 * contract and the host is only the mechanism.
 */
const decodeBytes = (
  value: string,
  alphabet: "base64" | "base64url",
): Uint8Array | null => {
  if (useNativeBase64()) {
    const fromBase64 = (Uint8Array as { fromBase64?: NativeFromBase64 })
      .fromBase64;
    if (typeof fromBase64 === "function") {
      try {
        // `strict` so the host itself also rejects non-zero unused bits and
        // incomplete final quanta; base64url input is padded to satisfy it.
        return fromBase64(
          alphabet === "base64url" ? padBase64Url(value) : value,
          { alphabet, lastChunkHandling: "strict" },
        );
      } catch {
        return null;
      }
    }
  }
  const standard =
    alphabet === "base64url"
      ? value.replaceAll("-", "+").replaceAll("_", "/")
      : value;
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Shared tail: the post-decode byte-length checks both formats run. */
const finishDecode = (
  bytes: Uint8Array | null,
  expectedByteLength: number,
  maxBytes: number,
): Base64DecodeResult => {
  if (bytes === null) return { ok: false, reason: "malformed" };
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "oversize" };
  if (bytes.byteLength !== expectedByteLength) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, bytes };
};

/** Standard Base64 with RFC 4648 canonical padding. */
export function encodeBase64(bytes: Uint8Array): string {
  if (useNativeBase64()) {
    const toBase64 = (
      bytes as Uint8Array & { toBase64?: NativeToBase64 }
    ).toBase64;
    if (typeof toBase64 === "function") {
      return toBase64.call(bytes, { alphabet: "base64" });
    }
  }
  return btoa(toBinaryString(bytes));
}

export function decodeBase64(
  value: string,
  options: Base64DecodeOptions,
): Base64DecodeResult {
  const maxBytes = assertMaxBytes(options.maxBytes);
  // Canonical padding implies whole quanta; anything else is truncated.
  if (value.length % 4 !== 0) return { ok: false, reason: "malformed" };
  const padCount = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedByteLength = (value.length / 4) * 3 - padCount;
  // Encoded-length bound first — before the O(n) body scan, not just before
  // allocation — so an oversize input costs O(1), not a scan of its length.
  if (decodedByteLength > maxBytes) return { ok: false, reason: "oversize" };
  const body = value.slice(0, value.length - padCount);
  // One pass rejects whitespace anywhere and misplaced or excess padding
  // (`A===`, `AB=A`, `====`, `Zg==Zg==`): everything that is not the matched
  // trailing padding is the body, so ws between pad characters lands here too.
  if (STANDARD_BODY_REJECT.test(body)) {
    return { ok: false, reason: "malformed" };
  }
  if (
    padCount > 0 &&
    !unusedBitsAreZero(body, STANDARD_ALPHABET, padCount === 2 ? 0b1111 : 0b11)
  ) {
    return { ok: false, reason: "malformed" };
  }
  return finishDecode(
    decodeBytes(value, "base64"),
    decodedByteLength,
    maxBytes,
  );
}

/** Base64URL, always unpadded. */
export function encodeBase64Url(bytes: Uint8Array): string {
  if (useNativeBase64()) {
    const toBase64 = (
      bytes as Uint8Array & { toBase64?: NativeToBase64 }
    ).toBase64;
    if (typeof toBase64 === "function") {
      return toBase64.call(bytes, { alphabet: "base64url", omitPadding: true });
    }
  }
  return btoa(toBinaryString(bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(
  value: string,
  options: Base64DecodeOptions,
): Base64DecodeResult {
  const maxBytes = assertMaxBytes(options.maxBytes);
  const remainder = value.length % 4;
  // A single leftover character can never carry a whole byte.
  if (remainder === 1) return { ok: false, reason: "malformed" };
  const decodedByteLength = Math.floor((value.length * 3) / 4);
  // Encoded-length bound before the O(n) alphabet scan, as above.
  if (decodedByteLength > maxBytes) return { ok: false, reason: "oversize" };
  // The alphabet excludes `=`, so padded input is malformed by construction.
  if (!BASE64URL_BODY.test(value)) return { ok: false, reason: "malformed" };
  if (
    remainder !== 0 &&
    !unusedBitsAreZero(value, BASE64URL_ALPHABET, remainder === 2 ? 0b1111 : 0b11)
  ) {
    return { ok: false, reason: "malformed" };
  }
  return finishDecode(
    decodeBytes(value, "base64url"),
    decodedByteLength,
    maxBytes,
  );
}
