// @vitest-environment node

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { ExcalidrawLibraryItems } from "@drawstuff/excalidraw-adapter/types";

import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import * as schema from "@/server/db/schema";
import {
  compressPersonalLibrary,
  decodeStoredPersonalLibrary,
  encodePersonalLibraryBase64,
  getCanonicalLibraryReturnUrl,
  PERSONAL_LIBRARY_FORMAT_VERSION,
  PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES,
  personalLibraryChecksum,
  type StoredPersonalLibrary,
} from "@/lib/personal-library";
import { compressData } from "@/lib/encode";
import {
  createPersonalLibraryPersistenceAdapter,
  PersonalLibraryConflictError,
  type PersonalLibraryApi,
} from "@/lib/personal-library-adapter";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });
const USER_A = "library-user-a";
const USER_B = "library-user-b";

const libraryItems = [
  {
    id: "item-1",
    status: "unpublished",
    created: 1,
    name: "Private item",
    elements: [{ id: "element-1", type: "rectangle" }],
  },
] as unknown as ExcalidrawLibraryItems;

function callerFor(userId: string) {
  return createCaller({
    db: testDb,
    headers: new Headers(),
    auth: {
      session: { id: `session-${userId}` },
      user: { id: userId },
    },
  } as unknown as TRPCContext);
}

async function putItems(
  userId: string,
  expectedRevision: number,
  items: ExcalidrawLibraryItems,
) {
  const compressed = await compressPersonalLibrary(items);
  return callerFor(userId).personalLibrary.put({
    expectedRevision,
    formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
    compressedDataBase64: encodePersonalLibraryBase64(compressed),
  });
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await testDb.delete(schema.personalLibrary);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: USER_A, name: "User A", email: "library-a@example.com" },
    { id: USER_B, name: "User B", email: "library-b@example.com" },
  ]);
});

describe("personal Library router", () => {
  it("creates, reloads, updates, and deletes all items", async () => {
    expect(await callerFor(USER_A).personalLibrary.get()).toBeNull();

    expect(await putItems(USER_A, 0, libraryItems)).toEqual({
      status: "saved",
      revision: 1,
    });
    const stored = await callerFor(USER_A).personalLibrary.get();
    expect(stored).toMatchObject({
      revision: 1,
      formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
    });
    expect((await decodeStoredPersonalLibrary(stored!)).libraryItems).toEqual(
      libraryItems,
    );

    expect(await putItems(USER_A, 1, [])).toEqual({
      status: "saved",
      revision: 2,
    });
    const emptied = await callerFor(USER_A).personalLibrary.get();
    expect((await decodeStoredPersonalLibrary(emptied!)).libraryItems).toEqual(
      [],
    );
  });

  it("isolates users and cascades the row when its account is deleted", async () => {
    await putItems(USER_A, 0, libraryItems);
    expect(await callerFor(USER_B).personalLibrary.get()).toBeNull();

    await testDb.delete(schema.user).where(eq(schema.user.id, USER_A));
    expect(await testDb.select().from(schema.personalLibrary)).toEqual([]);
  });

  it("returns a machine-readable conflict without overwriting the winner", async () => {
    await putItems(USER_A, 0, libraryItems);
    await putItems(USER_A, 1, []);

    expect(await putItems(USER_A, 1, libraryItems)).toEqual({
      status: "conflict",
      currentRevision: 2,
    });
    const stored = await callerFor(USER_A).personalLibrary.get();
    expect((await decodeStoredPersonalLibrary(stored!)).libraryItems).toEqual(
      [],
    );
  });

  it("rejects malformed base64, invalid envelopes, and decompression bombs", async () => {
    await expect(
      callerFor(USER_A).personalLibrary.put({
        expectedRevision: 0,
        formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
        compressedDataBase64: "!!!!",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const invalidEnvelope = await compressData(
      new TextEncoder().encode(JSON.stringify({ libraryItems: "nope" })),
      {},
    );
    await expect(
      callerFor(USER_A).personalLibrary.put({
        expectedRevision: 0,
        formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
        compressedDataBase64: encodePersonalLibraryBase64(invalidEnvelope),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const bomb = await compressData(
      new TextEncoder().encode("x".repeat(10 * 1024 * 1024 + 1)),
      {},
    );
    await expect(
      callerFor(USER_A).personalLibrary.put({
        expectedRevision: 0,
        formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
        compressedDataBase64: encodePersonalLibraryBase64(bomb),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects compressed payloads over the request/storage bound", async () => {
    const oversized = new Uint8Array(PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES + 1);
    const base64 = Buffer.from(oversized).toString("base64");
    await expect(
      callerFor(USER_A).personalLibrary.put({
        expectedRevision: 0,
        formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
        compressedDataBase64: base64,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("personal Library client adapter", () => {
  it("verifies checksum and reports load/save state", async () => {
    const compressed = await compressPersonalLibrary(libraryItems);
    const stored: StoredPersonalLibrary = {
      revision: 3,
      formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
      compressedDataBase64: encodePersonalLibraryBase64(compressed),
      byteLength: compressed.byteLength,
      checksum: await personalLibraryChecksum(compressed),
    };
    const statuses: string[] = [];
    const put = vi.fn(async () => ({ status: "saved" as const, revision: 4 }));
    const adapter = createPersonalLibraryPersistenceAdapter({
      api: { get: async () => stored, put },
      onStatus: (status) => statuses.push(status),
    });

    expect(await adapter.load({ source: "load" })).toEqual({ libraryItems });
    await adapter.save({ libraryItems: [] });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 3 }),
    );
    expect(statuses).toEqual(["loading", "saved", "saving", "saved"]);

    await expect(
      decodeStoredPersonalLibrary({ ...stored, checksum: "0".repeat(64) }),
    ).rejects.toThrow("checksum");
  });

  it("keeps the server revision and surfaces a conflict", async () => {
    const api: PersonalLibraryApi = {
      get: async () => null,
      put: async () => ({ status: "conflict", currentRevision: 7 }),
    };
    const adapter = createPersonalLibraryPersistenceAdapter({ api });
    await adapter.load({ source: "save" });
    await expect(adapter.save({ libraryItems })).rejects.toBeInstanceOf(
      PersonalLibraryConflictError,
    );
  });
});

describe("canonical Library return URL", () => {
  it("strips scene, collaboration, and fragment capabilities", () => {
    expect(
      getCanonicalLibraryReturnUrl(
        "http://localhost:3000/dashboard?scene=abc&collab-room=room#collab-key=secret",
      ),
    ).toBe("http://localhost:3000/");
  });
});
