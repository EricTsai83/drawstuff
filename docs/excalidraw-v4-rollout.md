# Excalidraw V4 rollout

V4 keeps complete native Excalidraw elements in a versioned application
envelope. The application reader accepts legacy raw Excalidraw payloads,
owned Whiteboard V3 payloads, and V4 during the rollout.

## Preconditions

1. Work against a database clone first.
2. Review the Drizzle schema diff and run `pnpm db:push` against the clone;
   there must be no migration file or handwritten migration SQL.
3. Stop if DB push reports a destructive operation or unexpected
   drop/truncate/type change.
4. Confirm an immutable database snapshot and tested restore path exist.
5. Confirm the application can be put into read-only mode before the data
   rewrite.

## Inspect and validate

The following command is a data backfill/validation utility, not a schema
migration. Run the read-only count:

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

After every unencrypted owned scene is V4 and the result is independently
verified, remove this one-off script, its package script, and backfill-only
tests. Do not keep an executable legacy rewrite path indefinitely.

## Encrypted shared scenes

Shared-scene decryption keys are URL fragments and never reach the server.
Existing V2/V3 shared payloads therefore remain at their original document
version and are opened through the compatibility reader. New and updated
shares are written as V4. Do not attempt to relabel encrypted payloads without
decrypting and validating them in the client.
