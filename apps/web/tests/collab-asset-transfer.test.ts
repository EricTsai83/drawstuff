import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ASSET_DATA_URL_BYTES,
  MAX_ROOM_ASSETS_PER_GENERATION,
} from "@drawstuff/collaboration/asset";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type {
  BinaryFileData,
  DataURL,
  FileId,
} from "@drawstuff/excalidraw-adapter/types";

import {
  collabAppState,
  collabImage,
  collabRectangle,
  editedElement,
} from "./support/collab-scene-fixtures";
import {
  createAssetBackend,
  createHarness,
  createSnapshotBackend,
  expectConverged,
  type AssetBackend,
  type AssetTestClient,
} from "./support/collab-session-harness";
import { requestUrl } from "./support/request-url";

/**
 * Encrypted asset transfer, end to end (Plan 17).
 *
 * The elements and the bytes travel on two different paths, and that is the whole
 * subject here: an image element goes through the relay as ordinary scene state,
 * while its bytes are sealed in the browser, stored by a backend that cannot read
 * them, and fetched by whoever needs them. So every test asserts on a *peer's
 * canvas*, not on a call — what matters is that the other person sees the image,
 * and that the scene keeps converging when they cannot.
 *
 * The backend is a fake, but the sealing is not: ciphertext here is produced by
 * the real codec under a real room key, so "the server never sees plaintext",
 * "tampering is refused" and "another generation cannot open this" are properties
 * of the actual crypto rather than of a stub.
 */

const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);
const FILE_C = "c".repeat(40);

/** A tiny but real PNG data URL; the payload only has to be a valid data URL. */
const dataUrlFor = (marker: string): DataURL =>
  `data:image/png;base64,AAECAwQFBgcICQoLDA0OD${marker}` as DataURL;

const imageFile = (
  fileId: string,
  overrides: Partial<BinaryFileData> = {},
): BinaryFileData => ({
  id: fileId as FileId,
  dataURL: dataUrlFor("w"),
  mimeType: "image/png",
  created: 1_710_000_000_000,
  lastRetrieved: 1_710_000_000_000,
  ...overrides,
});

/** Adds an image element plus its local bytes, the way a paste does. */
const pasteImage = (
  client: AssetTestClient,
  fileId: string,
  file: BinaryFileData = imageFile(fileId),
): void => {
  client.host.putLocalFile(file);
  client.edit((elements) => [
    ...elements,
    collabImage({ id: `img-${fileId.slice(0, 4)}`, fileId }),
  ]);
};

const expectStored = (backend: AssetBackend, fileIds: string[]) =>
  vi.waitFor(() => {
    expect(backend.storedIds()).toEqual([...fileIds].sort());
  });

const expectRendered = (client: AssetTestClient, fileId: string, url: string) =>
  vi.waitFor(() => {
    expect(client.host.files[fileId]?.dataURL).toBe(url);
  });

/**
 * Waits for the store to arm its retry timer, then fires it.
 *
 * The wait is the point: the timer is armed only after the lookup that missed has
 * come back, so advancing the clock before that would fire nothing and prove
 * nothing.
 */
const runRetry = async (client: AssetTestClient): Promise<void> => {
  await vi.waitFor(() => {
    expect(client.assetTimers.pendingCount).toBe(1);
  });
  client.assetTimers.advance(60_000);
};

describe("encrypted collaboration asset transfer", () => {
  let harness: ReturnType<typeof createHarness>;
  let backend: AssetBackend;

  beforeEach(() => {
    harness = createHarness();
    backend = createAssetBackend();
  });

  it("stores a pasted image as ciphertext the backend cannot read", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    pasteImage(alice, FILE_A, imageFile(FILE_A, { dataURL: dataUrlFor("z") }));
    await expectStored(backend, [FILE_A]);

    const ciphertext = backend.ciphertextFor(FILE_A);
    expect(ciphertext).toBeDefined();
    // The plaintext markers must not appear anywhere in what was uploaded: not
    // the data URL, not the MIME type, not the file id.
    const asText = new TextDecoder("latin1").decode(ciphertext);
    expect(asText).not.toContain("data:image/png");
    expect(asText).not.toContain(dataUrlFor("z"));
    expect(asText).not.toContain(FILE_A);
  });

  it("shows a pasted image to a peer that is already in the room", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    const bob = await harness.createAssetClient("client-bob", backend);
    alice.session.connect();
    bob.session.connect();
    harness.settle();

    pasteImage(alice, FILE_A);
    harness.settle();
    await expectStored(backend, [FILE_A]);
    // The element always arrives before the bytes — sealing and uploading take as
    // long as they take — so the receiver's first lookup may legitimately miss and
    // the image appears on its retry.
    if (bob.host.files[FILE_A] === undefined) await runRetry(bob);

    await expectRendered(bob, FILE_A, dataUrlFor("w"));
    expectConverged(alice, bob);
    // Bob asked for the id the element carried, and only that one.
    expect(backend.fetchCalls).toBe(1);
  });

  it("shows room images to a client that joins later", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);

    const carol = await harness.createAssetClient("client-carol", backend);
    carol.session.connect();
    harness.settle();

    await expectRendered(carol, FILE_A, dataUrlFor("w"));
    expectConverged(alice, carol);
  });

  it("restores room images from the durable snapshot after a refresh", async () => {
    const snapshots = createSnapshotBackend();
    const alice = await harness.createAssetClient("client-alice", backend, {
      snapshotStore: snapshots.createStore(),
    });
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);
    await alice.session.flushSnapshot();
    expect(snapshots.revision).toBeGreaterThan(0);
    // The room empties out: the durable snapshot is now the only copy of the
    // scene, which is the case a refresh has to recover from.
    alice.session.disconnect();
    harness.settle();

    // A refresh is a brand-new client with the same room link: no peers, nothing
    // on the canvas, and the stored baseline as its only source of elements.
    const reloaded = await harness.createAssetClient("client-reload", backend, {
      snapshotStore: snapshots.createStore(),
    });
    reloaded.session.connect();
    harness.settle();

    await expectRendered(reloaded, FILE_A, dataUrlFor("w"));
    expect(reloaded.baselineOutcomes).toContain("durable-snapshot");
  });

  it("retries an image whose upload has not landed yet", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    const bob = await harness.createAssetClient("client-bob", backend);
    alice.session.connect();
    bob.session.connect();
    harness.settle();

    // A slow upload: the element is broadcast the moment the image is pasted, and
    // the ciphertext does not land until later.
    backend.withholdUploads();
    pasteImage(alice, FILE_A);
    harness.settle();
    await vi.waitFor(() => {
      expect(backend.resolveCalls).toBe(1);
    });
    expect(bob.host.files[FILE_A]).toBeUndefined();
    // Bob converged on the element without the bytes: a missing image never holds
    // up element sync.
    expectConverged(alice, bob);

    backend.releaseUploads();
    await runRetry(bob);
    await expectRendered(bob, FILE_A, dataUrlFor("w"));
  });

  it("stops scheduling retries for an image the room never gets", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    const bob = await harness.createAssetClient("client-bob", backend);
    alice.session.connect();
    bob.session.connect();
    harness.settle();

    backend.withholdUploads();
    pasteImage(alice, FILE_A);
    harness.settle();

    // The scheduled chain is bounded: four attempts and then no timer at all, so
    // an asset that never arrives is not polled for.
    for (let round = 0; round < 3; round += 1) await runRetry(bob);
    await vi.waitFor(() => {
      expect(backend.resolveCalls).toBe(4);
    });
    expect(bob.assetTimers.pendingCount).toBe(0);
    expect(bob.host.files[FILE_A]).toBeUndefined();

    // But it is not given up on either: the id is rate limited, not abandoned, so
    // the next traffic that references it tries once more — an upload that is
    // merely slow must not cost the image permanently. The rate-limit window has
    // to pass first, which is exactly what stops that traffic from becoming a
    // lookup per message.
    backend.releaseUploads();
    bob.assetTimers.advance(60_000);
    expect(bob.assetTimers.pendingCount).toBe(0);
    alice.edit((elements) =>
      elements.map((element) =>
        element.type === "image" ? editedElement(element) : element,
      ),
    );
    harness.settle();
    await expectRendered(bob, FILE_A, dataUrlFor("w"));
  });

  /**
   * The offer the session hands the store is coalesced, and these lock what the
   * coalescing must never swallow: an image only becomes publishable when a live
   * element references it, and a session that was down owes the room a real
   * offer rather than a cache hit.
   */
  it("publishes an image whose element appears after its bytes", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    // One referenced image and one whose bytes are in the engine's file store
    // with nothing referencing them yet. The publishable set is {A}; the
    // file-store key set is already its final {A, B}.
    alice.host.putLocalFile(imageFile(FILE_B));
    pasteImage(alice, FILE_A);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.settle();
    await expectStored(backend, [FILE_A]);

    // B's element lands. The file-store keys did not change, so a cache keyed on
    // them would skip this flush and B would never reach the room.
    alice.edit((elements) => [
      ...elements,
      collabImage({ id: "img-late", fileId: FILE_B }),
    ]);
    await expectStored(backend, [FILE_A, FILE_B]);
  });

  it("re-offers a pending upload after a reconnect", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    // The upload fails while the image is pasted, so the store owes it a retry.
    backend.failNextUploads(1);
    pasteImage(alice, FILE_A);
    harness.settle();
    await vi.waitFor(() => {
      expect(backend.uploadCalls).toBe(1);
    });
    expect(backend.storedIds()).toEqual([]);

    // The session drops and the store's retry fires while it is down: there is
    // no live role, so the re-offer is refused and that timer is spent.
    alice.session.disconnect();
    harness.network.flush();
    await runRetry(alice);
    expect(backend.storedIds()).toEqual([]);

    // The rejoin publish is now the only thing left that can carry the image,
    // and the referenced id set is unchanged — so it must not be treated as a
    // cache hit.
    alice.session.connect();
    harness.settle();
    await expectStored(backend, [FILE_A]);
  });

  it("re-offers a failed upload after its element is deleted and restored", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    backend.failNextUploads(1);
    pasteImage(alice, FILE_A);
    harness.settle();
    await vi.waitFor(() => {
      expect(backend.uploadCalls).toBe(1);
    });
    expect(backend.storedIds()).toEqual([]);

    // The element is deleted before the store's retry fires, so both the flush
    // and the retry have nothing publishable and the retry is spent.
    const withImage = alice.host.elements;
    alice.edit((elements) =>
      elements.map((element) =>
        element.type === "image"
          ? editedElement(element, { isDeleted: true })
          : element,
      ),
    );
    harness.settle();
    await runRetry(alice);
    expect(backend.storedIds()).toEqual([]);

    // Undo brings the image back. The offer is identical to the one that failed,
    // so a latch held across the empty set would skip this flush for good.
    alice.host.setElements(withImage);
    alice.session.handleLocalSceneChange(alice.host.elements, collabAppState());
    alice.scheduler.runAll();
    harness.settle();
    await expectStored(backend, [FILE_A]);
  });

  it("refuses tampered ciphertext without retrying it", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);
    backend.corrupt(FILE_A);

    const bob = await harness.createAssetClient("client-bob", backend);
    bob.session.connect();
    harness.settle();

    await vi.waitFor(() => {
      expect(backend.fetchCalls).toBe(1);
    });
    // Authentication failure is terminal: the same bytes would fail again.
    expect(bob.assetTimers.pendingCount).toBe(0);
    expect(bob.host.files[FILE_A]).toBeUndefined();
    expect(bob.host.addedFileBatches).toEqual([]);

    // Giving up marks the element, and the mark is ordinary scene state: it
    // travels on the next broadcast exactly as it does upstream. The room
    // converges *on the error*, which is the truth about this asset — the stored
    // ciphertext is damaged for everybody, not just for Bob. Alice keeps
    // rendering the image regardless, because the engine draws it from the bytes
    // in her file store and not from this field.
    await vi.waitFor(() => {
      expect(bob.host.elements[0]).toMatchObject({ status: "error" });
    });
    bob.edit((elements) => elements);
    harness.settle();

    expect(alice.host.files[FILE_A]?.dataURL).toBe(dataUrlFor("w"));
    expectConverged(alice, bob);
  });

  /**
   * Making "this link cannot open the room's images" visible without making a
   * single damaged image noisy (Plan 30).
   *
   * The store's per-asset behaviour is unchanged throughout — every one of these
   * assets is still abandoned without a retry and the scene still converges. What
   * is under test is only the aggregate on top, which exists because "not uploaded
   * yet" and "will never open" used to look identical on the canvas: a missing
   * picture, and no message.
   */
  describe("telling an unopenable image from one that has not arrived", () => {
    /** A link carrying a key that was never this room's. */
    const STRANGER_KEY = generateRoomKey();

    it("reports a room whose images this link cannot open", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      await expectStored(backend, [FILE_A]);

      const stranger = await harness.createAssetClient(
        "client-stranger",
        backend,
        {
          roomKey: STRANGER_KEY,
        },
      );
      stranger.session.connect();
      harness.settle();

      await vi.waitFor(() => {
        expect(stranger.unreadableAssetReports.count).toBe(1);
      });
      // Reported, not repaired: the element still synced, the image simply is not
      // there, and the session is otherwise healthy.
      expect(stranger.host.files[FILE_A]).toBeUndefined();
      expect(stranger.assetTimers.pendingCount).toBe(0);
      expect(stranger.session.getRecoveryState()).toEqual({ phase: "live" });
    });

    it("reports assets sealed under an envelope version it cannot implement", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      await expectStored(backend, [FILE_A]);
      // What an `ASSET_CRYPTO_VERSION` bump does to a room's existing assets: the
      // key is right and the envelope is not, which is just as final and used to
      // be just as silent.
      backend.setStoredCryptoVersion(FILE_A, 99);

      const bob = await harness.createAssetClient("client-bob", backend);
      bob.session.connect();
      harness.settle();

      await vi.waitFor(() => {
        expect(bob.unreadableAssetReports.count).toBe(1);
      });
      // Not even fetched: the version is decided from the record alone.
      expect(backend.fetchCalls).toBe(0);
    });

    it("says nothing about an image the room has not stored yet", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      backend.withholdUploads();
      pasteImage(alice, FILE_A);

      const bob = await harness.createAssetClient("client-bob", backend);
      bob.session.connect();
      harness.settle();

      // The lookup comes back `missing`, which is the ordinary race between an
      // element and its bytes — the exact case this message must never claim.
      await vi.waitFor(() => {
        expect(bob.assetTimers.pendingCount).toBe(1);
      });
      expect(bob.unreadableAssetReports.count).toBe(0);

      backend.releaseUploads();
      await runRetry(bob);
      await expectRendered(bob, FILE_A, dataUrlFor("w"));
      expect(bob.unreadableAssetReports.count).toBe(0);
    });

    /**
     * The engine draws a distinct placeholder for `status: "error"`
     * (`IMAGE_ERROR_PLACEHOLDER_IMG`) and the ordinary one otherwise, so this
     * field *is* the user-visible difference between "not here yet" and "not
     * coming". Same mechanism the upstream collab app uses in
     * `updateStaleImageStatuses`.
     */
    const imageStatusOf = (
      client: AssetTestClient,
      elementId: string,
    ): unknown =>
      (
        client.host.elements.find((element) => element.id === elementId) as
          { status?: unknown } | undefined
      )?.status;

    it("marks an image this link cannot open as errored on the canvas", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      await expectStored(backend, [FILE_A]);

      const stranger = await harness.createAssetClient(
        "client-stranger",
        backend,
        { roomKey: STRANGER_KEY },
      );
      stranger.session.connect();
      harness.settle();

      await vi.waitFor(() => {
        expect(imageStatusOf(stranger, "img-aaaa")).toBe("error");
      });
      // The element itself still synced; only its picture is unavailable.
      expect(stranger.host.elements).toHaveLength(1);
      expect(stranger.host.files[FILE_A]).toBeUndefined();
    });

    it("leaves an image that has not arrived yet alone", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      const bob = await harness.createAssetClient("client-bob", backend);
      alice.session.connect();
      bob.session.connect();
      harness.settle();

      // The upload has not landed, so the lookup legitimately misses. Marking
      // this one would be the same lie the old silence was, in the other
      // direction: it says "never coming" about an image that is on its way.
      backend.withholdUploads();
      pasteImage(alice, FILE_A);
      harness.settle();
      await vi.waitFor(() => {
        expect(backend.resolveCalls).toBeGreaterThanOrEqual(1);
      });
      expect(imageStatusOf(bob, "img-aaaa")).not.toBe("error");

      backend.releaseUploads();
      await runRetry(bob);
      await expectRendered(bob, FILE_A, dataUrlFor("w"));
      expect(imageStatusOf(bob, "img-aaaa")).not.toBe("error");
    });

    it("marks the local user's own image when it can never be published", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();

      // Too large to seal: retrying cannot help, and before this the user was
      // given no sign that their own image would never reach anybody.
      pasteImage(
        alice,
        FILE_A,
        imageFile(FILE_A, {
          dataURL: `data:image/png;base64,${"A".repeat(
            MAX_ASSET_DATA_URL_BYTES,
          )}` as DataURL,
        }),
      );

      await vi.waitFor(() => {
        expect(imageStatusOf(alice, "img-aaaa")).toBe("error");
      });
      expect(backend.uploadCalls).toBe(0);
    });

    it("stays silent when one image is damaged but the link opens the room", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      pasteImage(alice, FILE_B);
      await expectStored(backend, [FILE_A, FILE_B]);
      backend.corrupt(FILE_B);

      const bob = await harness.createAssetClient("client-bob", backend);
      bob.session.connect();
      harness.settle();

      // One asset opening proves this link reads this room, so the other one is a
      // damaged or tampered image, not a wrong link — and a message telling the
      // user to ask for a new link would be advice that cannot help.
      await expectRendered(bob, FILE_A, dataUrlFor("w"));
      expect(bob.host.files[FILE_B]).toBeUndefined();
      expect(bob.unreadableAssetReports.count).toBe(0);

      // Per element, though: the damaged one is marked and the readable one is
      // untouched. That is the whole point of doing this at element granularity
      // rather than as one statement about the room.
      await vi.waitFor(() => {
        expect(imageStatusOf(bob, "img-bbbb")).toBe("error");
      });
      expect(imageStatusOf(bob, "img-aaaa")).not.toBe("error");

      bob.edit((elements) => elements);
      harness.settle();
      expectConverged(alice, bob);
    });

    it("waits for a concurrent lookup that is still opening a readable image", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      pasteImage(alice, FILE_B);
      await expectStored(backend, [FILE_A, FILE_B]);
      backend.corrupt(FILE_B);

      // Two `request` calls for disjoint ids run as separate lookups — which is
      // what happens in production when new elements arrive while the retry timer
      // is already fetching. Holding the *readable* one open forces the damaged
      // lookup to finish first, which is the ordering that used to produce a
      // false "this link cannot open the room's images".
      const readableUrl = `object-1`;
      let releaseReadable: (() => void) | undefined;
      const bob = await harness.createAssetClient("client-bob", backend, {
        wrapFetch:
          (inner) => (input: RequestInfo | URL, init?: RequestInit) => {
            const url = requestUrl(input);
            if (!url.endsWith(readableUrl)) return inner(input, init);
            return new Promise<Response>((resolve) => {
              releaseReadable = () => resolve(inner(input, init));
            });
          },
      });

      const readable = bob.assetStore.request([FILE_A]);
      const damaged = bob.assetStore.request([FILE_B]);
      await damaged;

      // The damaged lookup is done and found nothing openable, but the other one
      // has not had its chance yet.
      expect(bob.unreadableAssetReports.count).toBe(0);

      await vi.waitFor(() => expect(releaseReadable).toBeDefined());
      releaseReadable?.();
      await readable;

      // One image opened, so the link reads this room: the other one is damaged,
      // not unreachable, and must stay silent.
      await expectRendered(bob, FILE_A, dataUrlFor("w"));
      expect(bob.host.files[FILE_B]).toBeUndefined();
      expect(bob.unreadableAssetReports.count).toBe(0);
    });

    it("does not let a later lookup postpone a report that is already due", async () => {
      // The wait is fenced to the lookups already running when the evidence
      // appeared, not to the store going idle. A room whose images keep being
      // requested never goes idle, and the user would be told nothing for as long
      // as that lasts.
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      pasteImage(alice, FILE_B);
      pasteImage(alice, FILE_C);
      await expectStored(backend, [FILE_A, FILE_B, FILE_C]);

      // Every download is held, so a lookup only finishes when the test says so.
      const heldFetches: (() => void)[] = [];
      const bob = await harness.createAssetClient("client-bob", backend, {
        roomKey: STRANGER_KEY,
        wrapFetch: (inner) => (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            heldFetches.push(() => resolve(inner(input, init)));
          }),
      });

      // Two lookups are running when the first one finds an unopenable image, so
      // the cohort is both of them.
      const first = bob.assetStore.request([FILE_A]);
      const second = bob.assetStore.request([FILE_B]);
      await vi.waitFor(() => expect(heldFetches).toHaveLength(2));

      heldFetches[0]?.();
      await first;
      // Armed, and still waiting on the other cohort member.
      expect(bob.unreadableAssetReports.count).toBe(0);

      // A third lookup starts *after* the arming moment. It is outside the
      // cohort, so it must not extend the wait by one lookup more.
      const later = bob.assetStore.request([FILE_C]);
      await vi.waitFor(() => expect(heldFetches).toHaveLength(3));

      heldFetches[1]?.();
      await second;

      // The cohort has drained: the report is due now, with `later` still open.
      expect(bob.unreadableAssetReports.count).toBe(1);
      heldFetches[2]?.();
      await later;
    });

    it("reports at most once however many images cannot be opened", async () => {
      const alice = await harness.createAssetClient("client-alice", backend);
      alice.session.connect();
      harness.settle();
      pasteImage(alice, FILE_A);
      await expectStored(backend, [FILE_A]);

      const stranger = await harness.createAssetClient(
        "client-stranger",
        backend,
        {
          roomKey: STRANGER_KEY,
        },
      );
      stranger.session.connect();
      harness.settle();
      await vi.waitFor(() => {
        expect(stranger.unreadableAssetReports.count).toBe(1);
      });

      // A second unopenable image arrives later. The user has already been told
      // the one thing they can act on; repeating it per image would be noise.
      pasteImage(alice, FILE_B);
      await expectStored(backend, [FILE_A, FILE_B]);
      harness.settle();
      await vi.waitFor(() => {
        expect(backend.fetchCalls).toBeGreaterThanOrEqual(2);
      });
      expect(stranger.unreadableAssetReports.count).toBe(1);
    });
  });

  it("refuses an oversize image and an unsupported type instead of uploading them", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    pasteImage(
      alice,
      FILE_A,
      imageFile(FILE_A, {
        dataURL: `data:image/png;base64,${"A".repeat(
          MAX_ASSET_DATA_URL_BYTES,
        )}` as DataURL,
      }),
    );
    pasteImage(
      alice,
      FILE_B,
      // `BinaryFileData` admits this type; a room asset must not.
      imageFile(FILE_B, { mimeType: "application/octet-stream" }),
    );

    await vi.waitFor(() => {
      expect(alice.host.elements).toHaveLength(2);
    });
    expect(backend.uploadCalls).toBe(0);
    expect(backend.storedIds()).toEqual([]);
  });

  it("fetches one asset once however many elements reference it", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    alice.host.putLocalFile(imageFile(FILE_A));
    alice.host.putLocalFile(imageFile(FILE_B, { dataURL: dataUrlFor("q") }));
    alice.edit((elements) => [
      ...elements,
      collabImage({ id: "img-1", fileId: FILE_A }),
      collabImage({ id: "img-2", fileId: FILE_A }),
      collabImage({ id: "img-3", fileId: FILE_B }),
      collabRectangle({ id: "r1" }),
    ]);
    await expectStored(backend, [FILE_A, FILE_B]);

    const bob = await harness.createAssetClient("client-bob", backend);
    bob.session.connect();
    harness.settle();

    await expectRendered(bob, FILE_B, dataUrlFor("q"));
    // One lookup for the batch, one download per distinct asset, and one
    // injection — an `addFiles` per element would re-render the canvas per image.
    expect(backend.resolveCalls).toBe(1);
    expect(backend.fetchCalls).toBe(2);
    expect(bob.host.addedFileBatches).toHaveLength(1);
    expect(bob.host.addedFileBatches[0]).toHaveLength(2);
    expect(bob.host.addedFileBatches[0]).toEqual(
      expect.arrayContaining([FILE_A, FILE_B]),
    );
  });

  it("never uploads from a viewer session", async () => {
    const viewer = await harness.createAssetClient("client-viewer", backend, {
      role: "viewer",
    });
    viewer.session.connect();
    harness.settle();

    viewer.host.putLocalFile(imageFile(FILE_A));
    viewer.edit((elements) => [
      ...elements,
      collabImage({ id: "img-1", fileId: FILE_A }),
    ]);
    await vi.waitFor(() => {
      expect(viewer.host.elements).toHaveLength(1);
    });
    expect(backend.uploadCalls).toBe(0);
  });

  it("does not download an asset it uploaded itself", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);

    // The canvas already holds these bytes; asking for them would be a download
    // of an image the user is looking at.
    await alice.assetStore.request([FILE_A]);
    expect(backend.resolveCalls).toBe(0);
    expect(backend.fetchCalls).toBe(0);
  });

  it("shares one download between concurrent requests for the same asset", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);

    const bob = await harness.createAssetClient("client-bob", backend);
    await Promise.all([
      bob.assetStore.request([FILE_A]),
      bob.assetStore.request([FILE_A]),
      bob.assetStore.request([FILE_A]),
    ]);
    expect(backend.resolveCalls).toBe(1);
    expect(backend.fetchCalls).toBe(1);
  });

  it("releases every transfer and timer on teardown", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);

    const bob = await harness.createAssetClient("client-bob", backend);
    backend.setFailResolve(true);
    await bob.assetStore.request([FILE_A]);
    expect(bob.assetTimers.pendingCount).toBe(1);

    bob.assetStore.destroy();
    bob.session.destroy();
    expect(bob.assetTimers.pendingCount).toBe(0);

    // A request after teardown does nothing at all, so a late callback cannot
    // write another room's images onto a canvas that has moved on.
    backend.setFailResolve(false);
    await bob.assetStore.request([FILE_A]);
    expect(bob.host.files[FILE_A]).toBeUndefined();
    expect(bob.host.addedFileBatches).toEqual([]);
  });

  it("cancels a lookup that nobody answers when the room is left", async () => {
    const bob = await harness.createAssetClient("client-bob", backend);
    backend.hangResolve();
    const pending = bob.assetStore.request([FILE_A]);
    await vi.waitFor(() => {
      expect(backend.resolveCalls).toBe(1);
    });

    // Without a signal on the lookup, teardown would only take effect whenever the
    // network happened to answer — which for a hung request is never.
    bob.assetStore.destroy();
    await pending;
    expect(backend.resolveAborted).toBe(true);
  });

  it("keeps the whole transfer budget, not one per request", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    const fileIds = Array.from({ length: 8 }, (_, index) =>
      `${index}`.padEnd(40, "e"),
    );
    for (const fileId of fileIds) {
      alice.host.putLocalFile(imageFile(fileId));
    }
    alice.edit((elements) => [
      ...elements,
      ...fileIds.map((fileId, index) =>
        collabImage({ id: `img-${index}`, fileId }),
      ),
    ]);
    await expectStored(backend, fileIds);

    const bob = await harness.createAssetClient("client-bob", backend);
    // Two overlapping requests for disjoint assets: a per-request budget would let
    // each open its own four downloads and hold eight ciphertexts at once.
    await Promise.all([
      bob.assetStore.request(fileIds.slice(0, 4)),
      bob.assetStore.request(fileIds.slice(4)),
    ]);
    expect(backend.peakConcurrentTransfers).toBeLessThanOrEqual(4);
    expect(Object.keys(bob.host.files).sort()).toEqual([...fileIds].sort());
  });

  it("keeps a retry deadline that has not arrived yet", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    backend.withholdUploads();
    pasteImage(alice, FILE_A);
    pasteImage(alice, FILE_B);
    await vi.waitFor(() => {
      expect(backend.uploadCalls).toBe(2);
    });

    // Two assets miss at different moments, so their backoff deadlines are ~900ms
    // apart. The timer fires at the earlier one — and must take only that id: the
    // other's chain has to survive, or it would wait for unrelated traffic.
    const bob = await harness.createAssetClient("client-bob", backend);
    await bob.assetStore.request([FILE_A]);
    expect(bob.assetTimers.pendingCount).toBe(1);
    bob.assetTimers.advance(900);
    await bob.assetStore.request([FILE_B]);
    backend.releaseUploads();

    bob.assetTimers.advance(400);
    await expectRendered(bob, FILE_A, dataUrlFor("w"));
    // B's own deadline is still ahead, and it still has a timer of its own.
    expect(bob.host.files[FILE_B]).toBeUndefined();
    expect(bob.assetTimers.pendingCount).toBe(1);

    bob.assetTimers.advance(60_000);
    await expectRendered(bob, FILE_B, dataUrlFor("w"));
  });

  it("retries a failed upload without waiting for another edit", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    // The user pastes an image, the upload fails transiently, and then they stop
    // drawing: with no further scene flush, only the store's own timer can make the
    // image reach anybody.
    backend.failNextUploads(1);
    pasteImage(alice, FILE_A);
    await vi.waitFor(() => {
      expect(backend.uploadCalls).toBe(1);
    });
    expect(backend.storedIds()).toEqual([]);

    await vi.waitFor(() => {
      expect(alice.assetTimers.pendingCount).toBe(1);
    });
    alice.assetTimers.advance(5_000);
    await expectStored(backend, [FILE_A]);
  });

  it("ignores a malformed file id without losing the batch it arrived in", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();
    pasteImage(alice, FILE_A);
    await expectStored(backend, [FILE_A]);

    const bob = await harness.createAssetClient("client-bob", backend);
    // The lookup API rejects a whole batch containing one invalid id, so a single
    // bad `fileId` on a peer's element must not cost the valid images beside it.
    await bob.assetStore.request(["not/a/valid/id", FILE_A]);
    expect(bob.host.files[FILE_A]?.dataURL).toBe(dataUrlFor("w"));
    expect(backend.resolveCalls).toBe(1);

    // And it is never asked for again.
    await bob.assetStore.request(["not/a/valid/id"]);
    expect(backend.resolveCalls).toBe(1);
  });

  it("retries a failed upload even while a slower sibling is still going", async () => {
    const alice = await harness.createAssetClient("client-alice", backend);
    alice.session.connect();
    harness.settle();

    // Two images in one flush: the first upload fails immediately, the second is
    // still in flight when the retry falls due. A batch-wide in-flight claim would
    // make the retry skip exactly the file it was scheduled for.
    backend.failNextUploads(1);
    backend.holdNextUpload();
    alice.host.putLocalFile(imageFile(FILE_A));
    alice.host.putLocalFile(imageFile(FILE_B));
    alice.edit((elements) => [
      ...elements,
      collabImage({ id: "img-a", fileId: FILE_A }),
      collabImage({ id: "img-b", fileId: FILE_B }),
    ]);
    await vi.waitFor(() => {
      expect(alice.assetTimers.pendingCount).toBe(1);
    });

    alice.assetTimers.advance(5_000);
    await vi.waitFor(() => {
      // The failed id was re-offered rather than skipped.
      expect(backend.uploadCalls).toBeGreaterThanOrEqual(3);
    });
    backend.releaseHeldUpload();
    await expectStored(backend, [FILE_A, FILE_B]);
  });

  it("does not spin when more assets are missing than it can track", async () => {
    const bob = await harness.createAssetClient("client-bob", backend);
    // More ids than the bookkeeping bound, all absent. Retry state is evicted
    // FIFO, and an evicted id left in the retry queue would have no deadline —
    // which reads as "due now" and turns the timer into a zero-delay request loop.
    const fileIds = Array.from(
      { length: MAX_ROOM_ASSETS_PER_GENERATION + 40 },
      (_, index) => `${index}`.padStart(40, "c"),
    );
    await bob.assetStore.request(fileIds);
    const lookupsPerRound = Math.ceil(fileIds.length / 64);
    expect(backend.resolveCalls).toBe(lookupsPerRound);

    // Every armed retry has to be due in the *future*. A timer due at `now` is the
    // shape of the spin: it fires, evicts more state, and re-arms at zero delay.
    await vi.waitFor(() => {
      expect(bob.assetTimers.nextDueAt).toBeDefined();
    });
    expect(bob.assetTimers.nextDueAt).toBeGreaterThan(bob.assetTimers.now);

    // And the same has to hold after a round actually runs.
    bob.assetTimers.advance(60_000);
    await vi.waitFor(() => {
      expect(backend.resolveCalls).toBeGreaterThan(lookupsPerRound);
    });
    await vi.waitFor(() => {
      expect(bob.assetTimers.nextDueAt).toBeDefined();
    });
    expect(bob.assetTimers.nextDueAt).toBeGreaterThan(bob.assetTimers.now);
  });
});
