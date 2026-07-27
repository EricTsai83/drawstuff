# Whiteboard V2 completion record

## Status

The Phase 5K operational procedure is retired. Phase 5L removes its temporary
endpoint, configuration switch, data scanner, and runtime fallback paths after
the release and database owners approve the irreversible cutover.

The non-sensitive final audit belongs with the deployment release record,
including the completed inventory, database snapshot and restore evidence,
asset inventory, representative workflow results, and named approval. This
repository intentionally does not duplicate production identifiers or payload
details.

## Current invariant

- Owned and shared rows carry document version 2.
- Readers and writers accept only the current Drawstuff document format.
- Database constraints accept only the current document version.
- New browser, cloud, shared, and published writes use the same V2 serializer.
- Data-format defects are repaired forward.

## Stable physical identifiers

The `excalidraw-ericts_*` PostgreSQL table prefix and matching Drizzle filter are
stable physical identifiers, not supported product-format references. Changing
them requires paired `ALTER TABLE ... RENAME` statements and a matching filter
update in the same deployment; changing only application configuration would
point the application at missing or empty tables.
