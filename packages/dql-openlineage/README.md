# @zlens/openlineage

OpenLineage event emitter for ZLens projects. ZLens itself never calls it:
you call it from your own code, to send a lineage snapshot of a project or to
wrap runs you start.

## Install

```bash
npm i @zlens/openlineage
```

## Usage

```ts
import { createEmitter } from '@zlens/openlineage';

const emitter = createEmitter({
  url: process.env.OPENLINEAGE_URL,      // http://marquez.internal:5000/api/v1/lineage
  namespace: 'analytics',
});

await emitter.wrap(
  { namespace: 'analytics', name: 'block.revenue_by_segment' },
  crypto.randomUUID(),
  {
    inputs:  [{ namespace: 'analytics', name: 'orders' }],
    outputs: [{ namespace: 'analytics', name: 'block.revenue_by_segment' }],
  },
  async () => {
    // ... run the block ...
  },
);
```

## Config

Resolves from, in order:

1. Explicit args to `createEmitter({ … })`
2. `OPENLINEAGE_URL`, `OPENLINEAGE_NAMESPACE` env vars
3. Disabled (no-op) default

Hard opt-out:

```bash
export ZLENS_OPENLINEAGE_DISABLED=1
```

## Error policy

Network failures are swallowed (routed to `onError`) so infra issues never
surface to end users. Wrap-mode re-throws *handler* errors after emitting
`FAIL`.

## Receivers

Any receiver that accepts OpenLineage spec 0.19 events, such as Marquez or
DataHub. The package's tests check the event format; they do not run a
receiver.
See [docs/architecture/openlineage.md](../../docs/architecture/openlineage.md).

## Project snapshot from a compiled manifest

Phase 3.2 of the OSS plan: hydrate a Marquez (or any OL receiver) with the
full lineage graph of a ZLens project in one pass — dbt sources → dbt models →
DataLex contracts → DQL blocks → apps.

```ts
import { buildManifest } from '@zlens/core';
import { createEmitter, emitProjectSnapshot } from '@zlens/openlineage';

const manifest = buildManifest({ projectRoot: '.' });

const emitter = createEmitter({
  url: process.env.OPENLINEAGE_URL,         // http://marquez.local:5000/api/v1/lineage
  namespace: 'jaffle-shop',
});

const { emitted } = await emitProjectSnapshot(emitter, manifest);
console.log(`Emitted ${emitted} OpenLineage events.`);
```

What `emitProjectSnapshot` does:

- Walks every certified block in the manifest (filter via `blockStatuses`).
- Emits a `START` then `COMPLETE` event per block, sharing one run id.
- Marks the block's table dependencies, ref dependencies, and any
  `datalex_contract` reference as `inputs`.
- Marks the block itself as the `output`, attaching:
  - a **schema** facet (one entry per output column from the v2.4
    column-lineage pipeline)
  - a **columnLineage** facet that points each output column at the
    upstream `dbt.<model>` field it derives from
  - **documentation** + **ownership** job facets when the block has them

Dataset names use a stable convention so receivers can join graphs across
runs:

| artifact | dataset name |
|---|---|
| dbt model | `dbt.<model_name>` |
| DataLex contract | `datalex.<domain>.<Entity>.<contract_name>` (version stripped — Marquez/DataHub diff version on the lineage facets) |
| DQL block | `dql.block.<snake_case_name>` |

Use `buildEventsFromManifest(manifest, options)` if you need the events as
an array (tests, audit logs, custom transports).

### Marquez quickstart

```bash
git clone https://github.com/MarquezProject/marquez.git
cd marquez && ./docker/up.sh
```

Then in your ZLens project:

```bash
export OPENLINEAGE_URL=http://localhost:5000/api/v1/lineage
export OPENLINEAGE_NAMESPACE=jaffle-shop
node -e "
  import('@zlens/core').then(async ({ buildManifest }) => {
    const { createEmitter, emitProjectSnapshot } = await import('@zlens/openlineage');
    const manifest = buildManifest({ projectRoot: '.' });
    const emitter = createEmitter();   // picks up OPENLINEAGE_URL from env
    const { emitted } = await emitProjectSnapshot(emitter, manifest);
    console.log('Emitted', emitted, 'events.');
  });
"
```

Open `http://localhost:3000` (Marquez UI) and you should see your DQL blocks
with lineage edges into the dbt models they read from and the DataLex
contracts they implement.
