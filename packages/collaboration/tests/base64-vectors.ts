/**
 * Shared fixtures for the Base64 codec suites. One module feeds the Node,
 * Chromium, WebKit, and workerd projects so every host is held to the same
 * canonical profile — the whole point of Plan 08's shared codec.
 */

export type Base64Vector = {
  bytes: readonly number[];
  base64: string;
  base64url: string;
};

/** RFC 4648 §10 vectors plus high-byte tails that exercise `+/` vs `-_`. */
export const BASE64_VECTORS: readonly Base64Vector[] = [
  { bytes: [], base64: "", base64url: "" },
  { bytes: [0x66], base64: "Zg==", base64url: "Zg" },
  { bytes: [0x66, 0x6f], base64: "Zm8=", base64url: "Zm8" },
  { bytes: [0x66, 0x6f, 0x6f], base64: "Zm9v", base64url: "Zm9v" },
  { bytes: [0x66, 0x6f, 0x6f, 0x62], base64: "Zm9vYg==", base64url: "Zm9vYg" },
  {
    bytes: [0x66, 0x6f, 0x6f, 0x62, 0x61],
    base64: "Zm9vYmE=",
    base64url: "Zm9vYmE",
  },
  {
    bytes: [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72],
    base64: "Zm9vYmFy",
    base64url: "Zm9vYmFy",
  },
  { bytes: [0xfb], base64: "+w==", base64url: "-w" },
  { bytes: [0xff, 0xef], base64: "/+8=", base64url: "_-8" },
  { bytes: [0xff, 0xff, 0xff], base64: "////", base64url: "____" },
];

/**
 * Inputs the standard-profile decode must refuse. Grouped by the rule they
 * break; several are inputs a lenient host decoder happily accepts.
 */
export const MALFORMED_BASE64: readonly string[] = [
  // Truncated quantum (canonical padding implies whole quanta).
  "Zg",
  "Zg=",
  "Zm9vYg=",
  "Z",
  // Misplaced or excess padding.
  "Zg===",
  "====",
  "=Zg=",
  "Zg==Zg==",
  "Zm9v=AAA",
  // Whitespace anywhere (native fromBase64 would skip it; the guard must not).
  " Zg==",
  "Zg ==",
  "Zg==\n",
  "Z\tg==",
  "Zm9v ",
  // Foreign alphabet.
  "Zg-w",
  "Zg_w",
  "Zg?w",
  "Zg==!",
  // Decodable under a loose host but non-canonical: unused pad bits not zero.
  "Zh==",
  "Zm9=",
  "/+9=",
];

/** Inputs the Base64URL profile must refuse. */
export const MALFORMED_BASE64URL: readonly string[] = [
  // Any padding at all: the profile is fixed unpadded.
  "Zg==",
  "Zm8=",
  "Zm9vYg==",
  // length % 4 === 1 can never carry whole bytes.
  "Z",
  "Zm9vY",
  // Whitespace.
  " Zg",
  "Zg ",
  "Zm8\n",
  // Standard alphabet in a URL value.
  "-w+w",
  "_w/w",
  // Decodable under a loose host but non-canonical trailing bits.
  "Zh",
  "Zm9",
  "_-9",
];

/**
 * Independent reference encoder (plain bit arithmetic, test-only): the
 * production codec must agree with it on every host and both implementations.
 */
export function referenceBase64Encode(
  bytes: Uint8Array,
  options: { alphabet: "base64" | "base64url" },
): string {
  const alphabet =
    options.alphabet === "base64"
      ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const pad = options.alphabet === "base64";
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = Math.min(3, bytes.length - offset);
    const triple =
      ((bytes[offset] ?? 0) << 16) |
      ((bytes[offset + 1] ?? 0) << 8) |
      (bytes[offset + 2] ?? 0);
    out += alphabet.charAt((triple >> 18) & 63);
    out += alphabet.charAt((triple >> 12) & 63);
    if (remaining > 1) out += alphabet.charAt((triple >> 6) & 63);
    else if (pad) out += "=";
    if (remaining > 2) out += alphabet.charAt(triple & 63);
    else if (pad) out += "=";
  }
  return out;
}

/** mulberry32: tiny deterministic PRNG so payload fixtures are reproducible. */
export function seededBytes(length: number, seed: number): Uint8Array {
  let state = seed | 0;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    bytes[index] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return bytes;
}

/** True when this host implements the TC39 TypedArray Base64 API. */
export function hostHasNativeBase64(): boolean {
  return (
    typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 ===
      "function" &&
    typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === "function"
  );
}
