# Engineering conventions

- Status: Current
- Architecture boundary: [Drawstuff architecture contract](../architecture/architecture-contract.md)

These rules apply to repository changes that touch Excalidraw integration, persistence, or
collaboration.

## Implementation and cleanup

1. Keep each change within its stated scope. When responsibility moves, remove the replaced runtime
   path, duplicate abstraction, dead export, unused dependency, feature flag, fixture, and tests in
   the same change.
2. Preserve native scene fields, ordering, bindings, `versionNonce`, and tombstones. Do not add a
   second element model, history engine, serialization path, or merge algorithm.
3. Add unit, integration, or end-to-end coverage proportional to the risk. Compatibility readers are
   versioned contracts with an owner, stored-data audit, removal condition, and tests.
4. External input is byte-limited before parsing and runtime validation. Listener, timer, socket,
   object URL, queue, cache, and asynchronous work have explicit bounds and cleanup.
5. Production code does not use undocumented internals, DOM selectors, dual writes, silent fallback,
   open-ended compatibility shims, or `TODO`/`FIXME`/`HACK` as substitutes for the design.
6. Operational rollback uses deployment rollback or database/provider snapshots. Do not retain a
   second product implementation solely for rollback.

Repository-level completion checks are `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm knip`,
plus affected package and E2E checks. A known exception must be reported as a blocker, not silently
treated as completion.

## Performance

Hot-path changes use the fixed performance fixtures and compare against the relevant documented
budget. Do not introduce:

- unbounded queues or caches;
- scene serialization on pointer movement;
- full-scene broadcast for every `onChange`;
- unnecessary React commits or duplicate upstream rendering work.

If a change affects a measured hot path, record the same-machine baseline, new measurement, budget,
and rollback implication. Existing performance documents remain the source of numeric budgets.

## Database schema

Drizzle `apps/web/src/server/db/schema.ts` is the only schema source. Apply schema changes with
`pnpm db:push`. Do not generate migration files, migration SQL, or a shadow migration directory.

Before applying a schema change to the target environment:

1. materialize and inspect the schema diff in an isolated or production-shaped clone;
2. run a read-only target data audit and capture before counts;
3. verify backup/restore or an explicitly approved equivalent recovery proof;
4. run `pnpm db:push` in the clone and confirm constraints, indexes, query plans, and data counts;
5. apply the same push to the target and capture after counts and idempotency evidence.

If `db:push` reports a destructive warning, requires force, cannot express the required DDL, or
would require handwritten SQL, stop and obtain explicit approval before continuing.

## Constraint tightening and backfills

For existing data, tighten constraints in controlled stages:

```text
nullable schema push → bounded idempotent backfill → audit → final constraint push
```

A backfill is an operational job, not a migration. It must support dry-run/inspection, bounded
batches, checkpoint or manifest validation, idempotency, a concurrent-write strategy, and
reconcilable before/after counts. Intermediate nullable or dual-path state exists only inside the
controlled execution window. Remove backfill-only scripts and code after evidence is saved in the
durable design/operations document or change record.

## Active work retirement

The `plans/` directory contains only unfinished scoped work. When an active plan is completed, update
the corresponding current document in `docs/`, verify no source or documentation link depends on
the plan, and remove the plan file. Git history and merged change records retain execution evidence;
current design docs describe the resulting system rather than a decision timeline.
