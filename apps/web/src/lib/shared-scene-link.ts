/**
 * Share links carry the shared-scene id and its decryption key in the URL
 * fragment (`#json=<id>,<key>`), so the key never reaches the server.
 */
const SHARED_SCENE_HASH_RE = /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;
type ParsedSharedSceneHash = { id: string; key: string };

export function buildSharedSceneUrl(
  origin: string,
  { id, key }: ParsedSharedSceneHash,
): string {
  const url = new URL(origin);
  url.hash = `json=${id},${key}`;
  return url.toString();
}

export function parseSharedSceneHash(
  hash?: string,
): ParsedSharedSceneHash | null {
  if (hash === undefined) {
    if (typeof window === "undefined") return null;
    hash = window.location.hash;
  }
  const match = SHARED_SCENE_HASH_RE.exec(hash);
  if (!match?.[1] || !match?.[2]) return null;
  return { id: match[1], key: match[2] };
}
