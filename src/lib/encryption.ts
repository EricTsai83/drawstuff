import { ENCRYPTION_KEY_BITS } from "@/config/app-constants";

import type { ArrayBufferInput, Uint8ArrayLike } from "./array-buffer";
import { normalizeToArrayBuffer } from "./array-buffer";
import { blobToArrayBuffer } from "./blob";

export const IV_LENGTH_BYTES = 12;

export const createIV = () => {
  const arr = new Uint8Array(IV_LENGTH_BYTES);
  return window.crypto.getRandomValues(arr);
};

export async function generateEncryptionKey<
  T extends "string" | "cryptoKey" = "string",
>(returnAs?: T): Promise<T extends "cryptoKey" ? CryptoKey : string> {
  const key = await window.crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: ENCRYPTION_KEY_BITS,
    },
    true, // extractable
    ["encrypt", "decrypt"],
  );
  return (
    returnAs === "cryptoKey"
      ? key
      : (await window.crypto.subtle.exportKey("jwk", key)).k
  ) as T extends "cryptoKey" ? CryptoKey : string;
}

export const getCryptoKey = (key: string, usage: KeyUsage) =>
  window.crypto.subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: key,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    {
      name: "AES-GCM",
      length: ENCRYPTION_KEY_BITS,
    },
    false, // extractable
    [usage],
  );

export const encryptData = async (
  key: string | CryptoKey,
  data: Uint8ArrayLike | ArrayBuffer | Blob | File | string,
): Promise<{ encryptedBuffer: ArrayBuffer; iv: Uint8Array }> => {
  const importedKey =
    typeof key === "string" ? await getCryptoKey(key, "encrypt") : key;
  const iv = createIV();
  const ivBuffer: ArrayBuffer = normalizeToArrayBuffer(iv);
  const rawBuffer: ArrayBufferInput =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : data instanceof Blob
          ? await blobToArrayBuffer(data)
          : data;
  const buffer: ArrayBuffer = normalizeToArrayBuffer(rawBuffer);

  // We use symmetric encryption. AES-GCM is the recommended algorithm and
  // includes checks that the ciphertext has not been modified by an attacker.
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ivBuffer,
    },
    importedKey,
    buffer,
  );

  return { encryptedBuffer, iv };
};

export const decryptData = async (
  iv: Uint8Array,
  encrypted: Uint8ArrayLike | ArrayBuffer,
  privateKey: string,
): Promise<ArrayBuffer> => {
  const key = await getCryptoKey(privateKey, "decrypt");
  const ivBuffer: ArrayBuffer = normalizeToArrayBuffer(iv);
  const encryptedBuffer: ArrayBuffer = normalizeToArrayBuffer(encrypted);
  return window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ivBuffer,
    },
    key,
    encryptedBuffer,
  );
};
