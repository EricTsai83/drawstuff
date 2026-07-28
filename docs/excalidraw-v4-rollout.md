# Excalidraw V4 rollout

V4 keeps complete native Excalidraw elements in a versioned application
envelope. The application reader accepts legacy raw Excalidraw payloads,
owned Whiteboard V3 payloads, and V4 during the rollout.

## Preconditions

1. Work against a database clone first.
2. Apply `apps/web/drizzle/0001_excalidraw_v4_compatibility.sql`.
3. Confirm an immutable database snapshot exists.
4. Confirm the application can be put into read-only mode before execution.

## Inspect and validate

Run the read-only count:

```sh
pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- --inspect
```

Validate every unencrypted owned scene and capture the emitted checksum:

```sh
pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- --validate
```

Validation converts in memory, compresses the V4 result, reads it back, and
compares a semantic digest of all elements and asset metadata. It does not
write to the database.

## Execute

Pause writes, then supply both the exact validation checksum and the explicit
snapshot acknowledgement:

```sh
DRAWSTUFF_V4_MIGRATION_CONFIRM=I_HAVE_A_DATABASE_SNAPSHOT_AND_WRITES_ARE_PAUSED \
  pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- \
  --execute --manifest <checksum>
```

The update uses the source document version in its `WHERE` clause and aborts
if a row changed after validation. Run `--inspect` again before resuming
writes.

## Encrypted shared scenes

Shared-scene decryption keys are URL fragments and never reach the server.
Existing V2/V3 shared payloads therefore remain at their original document
version and are opened through the compatibility reader. New and updated
shares are written as V4. Do not attempt to relabel encrypted payloads without
decrypting and validating them in the client.
