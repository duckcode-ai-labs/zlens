# OpenLineage export

ZLens does not send [OpenLineage](https://openlineage.io) events on its own.
`zlens notebook`, `zlens sync` and the other commands never call an
OpenLineage endpoint, and `dql.config.json` has no OpenLineage setting.

What exists is the [`@zlens/openlineage`](../../packages/dql-openlineage)
package. From a script you run, it can:

- send a **snapshot** of a project's lineage to any OpenLineage receiver: each
  certified saved query, with the dbt models, tables and DataLex contracts it
  reads;
- **wrap your own code**, so each run sends `START`, then `COMPLETE` or `FAIL`.

## Send a snapshot

Install the package next to `@zlens/cli` in your project, point it at your
receiver, and run:

```bash
npm i -D @zlens/openlineage
export OPENLINEAGE_URL=http://localhost:5000/api/v1/lineage
export OPENLINEAGE_NAMESPACE=analytics
node -e "
  import('@zlens/core').then(async ({ buildManifest }) => {
    const { createEmitter, emitProjectSnapshot } = await import('@zlens/openlineage');
    const manifest = buildManifest({ projectRoot: '.' });
    const { emitted } = await emitProjectSnapshot(createEmitter(), manifest);
    console.log('Emitted', emitted, 'events.');
  });
"
```

Run it again whenever you want the receiver to catch up, for example in CI
after a merge to main. `ZLENS_OPENLINEAGE_DISABLED=1` turns it into a no-op.

## What a snapshot contains

For each certified saved query (pass `blockStatuses` to include others):

- a `START` and a `COMPLETE` event with one run id, for the job
  `dql.block.<name>`;
- its inputs: the tables and dbt models it reads (`dbt.<model>`), and its
  DataLex contract when it declares one;
- one output dataset with a `schema` facet and, when ZLens can trace them, a
  `columnLineage` facet pointing each column at the dbt column it comes from;
- `documentation` and `ownership` facets from its description and owner.

Events follow OpenLineage spec 0.19. The package's tests check the event
format and that events are posted; they do not run a receiver.

## Not done yet

- No events when a saved query, notebook cell or App runs in ZLens.
- No setting in `dql.config.json`; configure the package with environment
  variables or `createEmitter({ url, namespace })`.
