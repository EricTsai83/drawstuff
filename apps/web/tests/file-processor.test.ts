import type {
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  DataURL,
  FileId,
  NonDeletedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decompressData } from "@/lib/encode";
import { generateEncryptionKey } from "@/lib/encryption";
import { extractImageFiles, processFilesForUpload } from "@/lib/file-processor";

const fileId = (id: string): FileId => id as FileId;

const binaryFile = (id: string, dataURL = `data:image/png;base64,${id}`) =>
  ({
    id: fileId(id),
    mimeType: "image/png",
    dataURL: dataURL as DataURL,
    created: 1,
  }) satisfies BinaryFileData;

/** Only the fields `extractImageFiles` reads; the rest of an element is noise here. */
const element = (
  overrides: Record<string, unknown>,
): NonDeletedExcalidrawElement =>
  ({
    id: "el",
    type: "rectangle",
    isDeleted: false,
    ...overrides,
  }) as unknown as NonDeletedExcalidrawElement;

const files: BinaryFiles = {
  "file-a": binaryFile("file-a"),
  "file-b": binaryFile("file-b"),
};

describe("extractImageFiles", () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    [
      "a saved image whose file is present",
      { type: "image", fileId: "file-a" },
      ["file-a"],
    ],
    [
      "an image whose file is missing",
      { type: "image", fileId: "file-missing" },
      [],
    ],
    [
      "an image that has not been initialised",
      { type: "image", fileId: null },
      [],
    ],
    [
      "a non-image element carrying a fileId",
      { type: "rectangle", fileId: "file-a" },
      [],
    ],
  ])("%s", (_label, overrides, expectedIds) => {
    const result = extractImageFiles([element(overrides)], files);
    expect([...result.keys()]).toEqual(expectedIds);
    for (const id of expectedIds)
      expect(result.get(fileId(id))).toBe(files[id]);
  });

  it("dedupes elements that share a file and keeps first-seen order", () => {
    const result = extractImageFiles(
      [
        element({ id: "1", type: "image", fileId: "file-b" }),
        element({ id: "2", type: "image", fileId: "file-a" }),
        element({ id: "3", type: "image", fileId: "file-b" }),
      ],
      files,
    );
    expect([...result.keys()]).toEqual(["file-b", "file-a"]);
  });

  it("returns an empty map for an empty scene", () => {
    expect(extractImageFiles([], files).size).toBe(0);
  });
});

describe("processFilesForUpload", () => {
  const NOW = 1_710_000_000_000;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const decode = async (buffer: Uint8Array, key = "unused-when-plain") => {
    const { metadata, data } = await decompressData<BinaryFileMetadata>(
      buffer,
      { decryptionKey: key },
    );
    return { metadata, text: new TextDecoder().decode(data) };
  };

  it("returns nothing for no files", async () => {
    await expect(
      processFilesForUpload({ files: new Map(), maxBytes: 1 }),
    ).resolves.toEqual([]);
  });

  it("compresses each file with its metadata, in input order, unencrypted by default", async () => {
    const input = new Map<FileId, BinaryFileData>([
      [fileId("file-b"), binaryFile("file-b")],
      [fileId("file-a"), binaryFile("file-a")],
    ]);
    const result = await processFilesForUpload({
      files: input,
      maxBytes: 1024,
    });

    expect(result.map((file) => file.id)).toEqual(["file-b", "file-a"]);
    const first = await decode(result[0]!.buffer);
    expect(first.text).toBe("data:image/png;base64,file-b");
    expect(first.metadata).toEqual({
      id: "file-b",
      mimeType: "image/png",
      created: NOW,
      lastRetrieved: NOW,
    });
  });

  it("encrypts with the supplied key so only that key can read it back", async () => {
    const key = await generateEncryptionKey("string");
    const otherKey = await generateEncryptionKey("string");
    const [processed] = await processFilesForUpload({
      files: new Map([[fileId("file-a"), binaryFile("file-a")]]),
      maxBytes: 1024,
      encryptionKey: key,
    });

    const opened = await decode(processed!.buffer, key);
    expect(opened.text).toBe("data:image/png;base64,file-a");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(decode(processed!.buffer, otherKey)).rejects.toThrow();
  });

  it.each<[string, number, number, boolean]>([
    ["exactly at the limit", 64, 64, true],
    ["one byte over the limit", 65, 64, false],
    ["far over a megabyte limit", 3 * 1024 * 1024, 2 * 1024 * 1024, false],
  ])(
    "a data URL %s (%i bytes, max %i) is accepted: %s",
    async (_label, bytes, maxBytes, accepted) => {
      const input = new Map([
        [fileId("big"), binaryFile("big", "x".repeat(bytes))],
      ]);
      const run = processFilesForUpload({ files: input, maxBytes });
      if (accepted) {
        await expect(run).resolves.toHaveLength(1);
      } else {
        await expect(run).rejects.toThrow(
          `File too big: ${Math.trunc(maxBytes / 1024 / 1024)}MB limit exceeded`,
        );
      }
    },
  );

  it("measures the UTF-8 byte length, not the character count", async () => {
    // Three characters, nine bytes.
    const input = new Map([[fileId("utf8"), binaryFile("utf8", "圖片檔")]]);
    await expect(
      processFilesForUpload({ files: input, maxBytes: 8 }),
    ).rejects.toThrow(/File too big/);
    await expect(
      processFilesForUpload({ files: input, maxBytes: 9 }),
    ).resolves.toHaveLength(1);
  });

  it("rejects the whole batch when any file is oversize", async () => {
    const input = new Map<FileId, BinaryFileData>([
      [fileId("ok"), binaryFile("ok", "small")],
      [fileId("big"), binaryFile("big", "x".repeat(100))],
    ]);
    await expect(
      processFilesForUpload({ files: input, maxBytes: 50 }),
    ).rejects.toThrow(/File too big/);
  });
});
