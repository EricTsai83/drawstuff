# Collaboration storage and personal draft boundary

This contract describes the current scene-linked room implementation. Room authorization remains
DB-authoritative; independent rooms, local key retention, and the authority reset belong to the
active [authority plan](../../plans/18b-collaboration-authority-reset.md) and
[surface plan](../../plans/18c-collaboration-surface.md).

## Storage modes and destinations

`getEditorStorageMode()` is the synchronous boundary: either the tab's canvas-room claim or its
collaboration persistence hold selects room mode. The hold starts before any room elements are
applied, including room-link initialization. All save entrances use the same boundary.

| Entrance | Personal mode | Room mode | Destination |
| --- | --- | --- | --- |
| Toolbar, main menu | Save to my scenes; update the open scene or name a new one | Save/retry the room through its elected writer | Current mode's durable store |
| Copy action, cloud export | Name a personal scene when needed | Save a named personal copy | Personal scene and independently uploaded assets |
| Ctrl/Cmd+S | Save the personal scene | Request the elected writer to save; viewer cannot write | Current mode's durable store |
| Persistent editor status | Personal scene | Room identity, pending/saving/saved/failed, retry | Shared encrypted room snapshot |
| Local download | Native file export | Download local copy; explain that the file is unencrypted | Downloaded file |
| Update original | Ordinary personal update | Separate named action for the owner whose source matches | Explicit original scene with expected revision |

The room status is independent of personal-upload toasts. Saving a copy never confirms room edits.
Copies use the existing name/workspace dialog, capture one consistent element/app-state/file set,
filter files to references, and fail if a referenced file is absent. Success leaves the room canvas
and personal scene session unchanged. Further room edits cannot automatically update the copy.
Its files are uploaded into the personal asset lifecycle; it has no source-room cascade relation.
The room-copy dialog explains that the room remains encrypted and the personal cloud copy has no
end-to-end encryption. A personal copy is still access-controlled, not public.

Updating the original requires a fresh room ownership/source check and the revision preserved
before entry. It never substitutes a newly fetched revision to bypass a conflict. A changed original
keeps the room intact and reuses the conflict dialog with room-specific copy/continue actions;
it cannot hydrate the remote personal scene into a live room. The user can save a named copy or
leave and reload the original. A successful commit updates the preserved personal canvas/revision. If it completes after
leaving, the stale shared local canvas cache is invalidated and its old revision still protects the
open stale canvas from silently overwriting the committed version.

## Cross-member durable confirmation

UploadThing room objects retain public ACLs and contain ciphertext only. Authorized asset resolution
returns their permanent download URLs. Revocation blocks subsequent application API resolution and
upload/finalize, but cannot invalidate a URL already learned or otherwise obtained while its object
exists. A holder of the matching room key can still decrypt it; downloaded copies cannot be recalled.
This provider-level download limitation is explicitly accepted for now. Private uploads, proxy reads
and a provider upgrade are not prerequisites for the authority reset.

`save-state.ts` compares exact canonical coverage: sorted tuples of element ID, version,
versionNonce, and isDeleted, using the same identity contract as the snapshot digest. Coverage
includes syncable tombstones and conflict winners. Confirmation records the actual durable revision
and sealed checksum; only coverage matching the current syncable canvas yields **saved**. A write
captured before another edit cannot confirm that newer edit. Older revisions cannot replace newer
confirmation, and a new connection resets confirmation.

Protocol v5 adds encrypted `snapshot-control` messages to the existing scene sequence:

- `request` carries a coalesced request ID. Nonwriters publish pending deltas before requesting;
  only the elected editor/owner writes. Requests obey baseline, role, generation, budget, and
  in-flight guards and never invoke the election-bypassing leave flush.
- `persisted` carries capture ID, authorization generation, durable revision, and ciphertext
  checksum. A member treats it as a hint and reads the real stored snapshot, decrypting and
  validating its revision/checksum seal before confirming coverage. A peer cannot assert durability.

These controls share sequence-gap recovery with scene deltas and contain no cleartext scene
metadata on the wire. Receipts are coalesced to at most one verification read per second. Pending
nonwriters independently verify on the 30-second cadence, so a lost notification is recoverable;
reconnect loads the durable baseline again. Writer loss uses the existing deterministic election.
There is no database query on each stroke or pointer update.

Before confirming a snapshot, all referenced assets must have finalized records in the same
current generation. The writer publishes available local files and performs bounded batched
availability checks. Missing assets prevent both a successful confirmation and a new durable write.
An unchanged previously loaded digest still permits independent confirmation retry after attachments
become available.

Snapshot HTTP requests and availability lookups have 15-second deadlines and abort signals.
Manual save requests become failed/unconfirmed after the 30-second snapshot interval if no covering
confirmation arrives. Errors retain edits and permit retry; a late real confirmation can still
establish coverage. A lost write response is reconciled by subsequent conditional write/read,
never treated as an ACK. These are request/cadence intervals, not a data-loss guarantee.

The undeployed 18B P2 source now uses binary snapshot read/write/reset. The store retains one
original operation and ciphertext in memory, queries before retry, and cancels expired pending
work before minting another intent. A recovered old capture cannot confirm newer edits. New write
attempts invalidate prior saved coverage, and empty reads retain reset's revision watermark;
see [the P2 product source boundary](collaboration-system-design.md#18b-p2-product-binary-snapshots).
Attachment-free product initialization now confirms the encrypted initial snapshot and ready receipt
before sharing a key; image-bearing initialization confirms every referenced encrypted asset before its snapshot and ready manifest. See the
[initialization source boundary](collaboration-system-design.md#18b-p2-product-attachment-authority).
Production still uses the earlier deployment until P2 completion and P3 reset.

**Confirmed data is durable; unconfirmed data may be lost when its last browser holder exits.**
Beforeunload and explicit leave/end read live coverage and warn when it is unconfirmed. The existing
best-effort leave flush is retained, but unload networking is not a durability guarantee. There is
no offline recovery promise, IndexedDB room cache, Background Sync, or persisted upload intent.
Future authority work must preserve this product meaning while adding operation lookup/cancel.

## Personal cache and recovery

Room elements and images use engine memory and remote encrypted storage. All automatic personal
canvas writers are held for owners and guests, regardless of source scene ID or successful copies.
`saveData`/`saveToLocalStorage` check the hold at the actual write, not just scheduling time.
Debounce cancellation, unload, personal/shared hydration and revision reloads respect the boundary.
Pending asynchronous hydration checks again after awaiting its data.

Before the handoff, `personal-draft.ts` stores only the **pre-room personal** elements, persisted UI
fields, files, scene ID, revision, workspace and dirty flag in the tab's sessionStorage. The identity
comes from that tab's synchronous scene-session getter, not another tab's shared localStorage.
The existing local personal cache remains personal. Room contents are never automatically added to
that backup, and no room edit changes personal dirty/revision state.

| Transition | Canvas and cache contract |
| --- | --- |
| Entry | Verify key and authorization first; preserve personal draft, cancel pending save, hold writers, then claim/reset canvas |
| Fresh empty source room | Its owner's currently open source may seed the room once |
| Room-link reload | Preserve any cached personal draft, start blank/read-only and recover from an authorized encrypted baseline; never publish the personal cache |
| Missing key, unavailable/unreadable baseline | Report the existing recovery failure; never treat the empty canvas or personal cache as a valid room baseline |
| Leave, initialization failure after handoff, URL removal | Clear room files/history, restore the preserved personal canvas/metadata, then release writers and save that personal cache |
| Terminal revocation | Retain the room's read-only recovery/error surface; explicit leave restores the preserved personal draft |
| Sign-out/auth loss | Clear the backup and reset engine memory; do not restore private personal data into a signed-out session |
| Other tab saves | Cannot replace this tab's preserved original; room edits cannot pollute the shared personal cache |
| Explicit original update | Replace only its preserved original after success; copying never releases the room hold |

Personal draft storage failure stops entry before the canvas changes. UI preferences and the tab
room marker have separate lifecycles and are permitted; this contract concerns canvas contents,
not a claim that rooms leave no local metadata. Key retention is outside this implementation.

## Executable evidence

`collab-personal-draft.test.ts`, `collab-local-persistence.test.tsx`, and room status/controller tests
cover write holds, restoration, reloads, failed joins and role withdrawal. `collab-save-state.test.ts`
and existing snapshot/recovery tests exercise fake multi-member networks, stale/forged confirmations,
coalesced requests, writer takeover, missing attachments and retries. `collab-cloud-copy.test.tsx`
checks independent personal uploads, source revision protection and preservation of room identity.
`collab-source-conflict-dialog.test.tsx` guards the copy/continue surface against remote hydration.
`collab-request-deadline.test.ts` checks a lost HTTP response and cancellation. Full repository checks
remain `pnpm check`; these tests are local evidence, not production latency measurements.

The surface plan extends these rules to rooms without a source: omit the original-update entrance,
retain copy/download/save semantics, and rerun the same matrix with no scene ID. Its global encryption
notices must not weaken the cache or copy boundary above.


### Progressive client asset delivery

The client keeps a shared limit of four concurrent asset transfers. Authenticated,
decoded images are delivered to the canvas in groups of at most four, or after a
32 ms coalescing window. A completed lookup flushes its remaining images before
its request resolves. A slow asset cannot hold every completed image in the lookup
until the whole batch finishes, and the delivery queue retains at most three files
between flushes in addition to the active transfers. Teardown cancels the delivery
timer and drops those files; late downloads cannot apply to a departed session.
Lookup deduplication, retry budgets, generation validation and unreadable-key
verdicts still apply across the entire request. This improves partial rendering in
rooms with several images; it does not reduce a single image's provider latency
or establish that the production join/save SLO has passed.
