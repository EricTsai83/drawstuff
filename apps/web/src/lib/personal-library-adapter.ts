import type {
  ExcalidrawLibraryPersistenceAdapter,
  ExcalidrawLibraryItems,
} from "@drawstuff/excalidraw-adapter/types";

import {
  compressPersonalLibrary,
  decodeStoredPersonalLibrary,
  encodePersonalLibraryBase64,
  PERSONAL_LIBRARY_FORMAT_VERSION,
  PERSONAL_LIBRARY_NO_REVISION,
  type StoredPersonalLibrary,
} from "@/lib/personal-library";

export type PersonalLibrarySyncStatus =
  "checking-auth" | "anonymous" | "loading" | "saving" | "saved" | "error";

export type PersonalLibraryApi = {
  get: () => Promise<StoredPersonalLibrary | null>;
  put: (input: {
    expectedRevision: number;
    formatVersion: typeof PERSONAL_LIBRARY_FORMAT_VERSION;
    compressedDataBase64: string;
  }) => Promise<
    | { status: "saved"; revision: number }
    | { status: "conflict"; currentRevision: number }
  >;
};

export class PersonalLibraryConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("Personal Library changed in another tab or device.");
    this.name = "PersonalLibraryConflictError";
    this.currentRevision = currentRevision;
  }
}

export function createPersonalLibraryPersistenceAdapter(options: {
  api: PersonalLibraryApi;
  onStatus?: (status: PersonalLibrarySyncStatus) => void;
}): ExcalidrawLibraryPersistenceAdapter {
  let revision = PERSONAL_LIBRARY_NO_REVISION;

  return {
    async load({ source }) {
      if (source === "load") options.onStatus?.("loading");
      try {
        const stored = await options.api.get();
        revision = stored?.revision ?? PERSONAL_LIBRARY_NO_REVISION;
        if (!stored) {
          if (source === "load") options.onStatus?.("saved");
          return null;
        }
        const envelope = await decodeStoredPersonalLibrary(stored);
        if (source === "load") options.onStatus?.("saved");
        return envelope;
      } catch (error) {
        options.onStatus?.("error");
        throw error;
      }
    },

    async save(libraryData: { libraryItems: ExcalidrawLibraryItems }) {
      options.onStatus?.("saving");
      try {
        const compressed = await compressPersonalLibrary(
          libraryData.libraryItems,
        );
        const result = await options.api.put({
          expectedRevision: revision,
          formatVersion: PERSONAL_LIBRARY_FORMAT_VERSION,
          compressedDataBase64: encodePersonalLibraryBase64(compressed),
        });
        if (result.status === "conflict") {
          revision = result.currentRevision;
          throw new PersonalLibraryConflictError(result.currentRevision);
        }
        revision = result.revision;
        options.onStatus?.("saved");
      } catch (error) {
        options.onStatus?.("error");
        throw error;
      }
    },
  };
}
