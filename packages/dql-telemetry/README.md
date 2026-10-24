# @zlens/telemetry

> **Deprecated.** No ZLens package or CLI command uses this package, and there is
> no `zlens telemetry` command. ZLens does not send usage telemetry. The package is
> kept only so existing installs keep resolving, and it may be removed in a
> future release. Do not add it to new projects. The text below describes the
> library as written, not a feature of the ZLens CLI.

Opt-in, privacy-first usage telemetry for DQL.

## Principles

1. **Off by default.** Must be explicitly enabled.
2. **No PII.** Ever. Only enum-valued counters and durations.
3. **One-line opt-out.** `DO_NOT_TRACK=1`, `DQL_TELEMETRY_DISABLED=1`, or `dql telemetry off`.
4. **Transparent event schema.** Documented below; nothing hidden.
5. **Never blocks the CLI.** 2-second timeout, silent on failure.

## What gets sent

Exactly these fields, nothing else:

```json
{
  "event": "cli.command",
  "anonymousId": "uuid-or-hostname-hash",
  "version": "1.0.0",
  "ts": "2026-04-15T12:34:56Z",
  "props": {
    "command": "init",
    "success": true
  },
  "durationMs": 42
}
```

Events emitted today:

| Event | When | Props (enum-only) |
| --- | --- | --- |
| `cli.command` | any `dql <subcmd>` finishes | `command`, `success` |
| `notebook.open` | notebook boots | — |
| `block.certified` | a block is promoted | `domain` |
| `dbt.synced` | `dql sync dbt` finishes | `modelsAdded`, `modelsRemoved` (counts only) |
| `dashboard.built` | `dql build` finishes | `chartCount` |

No file names, query contents, warehouse URLs, schema names, block names,
or any other potentially-sensitive strings are ever transmitted.

## Opt out

Any of these disable telemetry:

```bash
export DO_NOT_TRACK=1             # respects the DNT standard
export DQL_TELEMETRY_DISABLED=1
dql telemetry off                 # persists to ~/.config/dql/telemetry.json
```

## Opt in

```bash
dql telemetry on
```

Or programmatically:

```ts
import { setEnabled } from '@zlens/telemetry';
setEnabled(true);
```

## Source

Open source, MIT. See
[`src/index.ts`](./src/index.ts). There is no compiled/minified blob.
