# Contributing to ZLens

Thank you for your interest in ZLens. Contributions that improve the language, tooling, connectors, or documentation are welcome.

---

## Scope

This repository covers the open ZLens layer:

- Language core: lexer, parser, AST, semantic analysis, formatter
- Compiler: IR lowering, HTML/React code generation
- Runtime: browser data fetching and hot-reload
- Connectors: database driver abstraction (DuckDB, Postgres, BigQuery, Snowflake, etc.)
- Governance: certification rules and cost estimation
- LSP: language server for VS Code and compatible editors
- Project: Git-backed block registry and project primitives
- CLI: `zlens` commands
- Docs and examples

The local notebook and governed agent workflows shipped by ZLens are OSS scope.
Managed multi-tenancy, SSO/RBAC, centralized audit, managed secrets, hosted
approvals, and other commercial control-plane behavior are not.

Before a non-trivial change, read the
[current ZLens truth](./docs/contribute/current-dql-truth.md) and follow the
[OSS delivery orchestration playbook](./docs/contribute/delivery-orchestration.md).

---

## Development Setup

Requires Node.js 20, 22, 24 or 26 (CI tests all four) and pnpm 9. Node 26 LTS
is recommended.

```bash
git clone https://github.com/duckcode-ai-labs/zlens.git
cd zlens
pnpm install
pnpm build
pnpm test
```

The repo uses [Turborepo](https://turbo.build/) for incremental builds. After the first full build, `pnpm build` only rebuilds changed packages.

Build through `pnpm build` (or each package's own `build` script, in dependency
order), not with `npx tsc -b` in `apps/cli` alone: TypeScript's project
references there do not build the UI packages (`@zlens/ui`,
`@zlens/charts`), so the notebook build then fails with
`TS2307: Cannot find module '@zlens/ui'`. To build only what the
CLI and the notebook need, dependencies first:

```bash
pnpm -r --filter "zlens..." --filter "@zlens/notebook-app..." run build
```

### Checks for hosted servers and the single-user product

`scripts/hardening-checks/` holds three helpers for checking a change to the
hosted (RFC 0010) paths against the single-user product. Nothing in `pnpm test`
runs them.

- `standalone-diff.mjs --baseline <checkout> --candidate <checkout> --out <dir>`
  starts `zlens notebook` from two built checkouts on two copies of one scratch
  project, sends both the same requests (notebook, Ask, Apps, Block Studio, git,
  connectors, export, MCP) and lists every step whose answer differs.
  `HOST_CHECK_NETWORK_LOG=1` records what each server tries to reach off this
  machine; `HOST_CHECK_PG_NODE_MODULES` (a `node_modules` holding `pg`) adds a
  throwaway PostgreSQL connection.
- `run-oss-suites.sh <checkout> <dir>` runs the packages' suites one after
  another, the CLI suite with its network record and with its sockets sampled
  (`sample-sockets.sh`).

`pnpm --filter zlens test:offline` runs the CLI suite and fails
on any lookup or connection off this machine. Set `HOST_CHECK_EVIDENCE_DIR` to
keep the records the host-hook fault, concurrency and model-boundary tests
write.

### Running a single package

```bash
pnpm --filter @zlens/core build
pnpm --filter @zlens/core test
```

### Running the notebook dev server

```bash
pnpm --filter @zlens/notebook-app dev   # Vite dev server for the UI
pnpm --filter zlens build
node apps/cli/dist/index.js notebook                  # built CLI server, default port 3474
```

Vite alone does not count as UI verification: check UI changes against the
built `zlens notebook` CLI (see [AGENTS.md](./AGENTS.md)).

---

## Project Structure

```
apps/
  cli/                   zlens CLI entry point and local notebook server
  dql-notebook/          React notebook UI (Vite)
  notebook-browser/      Browser notebook build
  desktop/               Tauri desktop shell
  vscode-extension/      VS Code extension package
packages/
  dql-core/              Lexer, parser, AST, semantic layer, formatter
  dql-compiler/          IR lowering and code generation
  dql-runtime/           Browser runtime
  dql-connectors/        Database driver layer
  dql-governance/        Certification and cost rules
  dql-lsp/               Language server
  datalex-lsp/           DataLex language server
  dql-project/           Git-backed registry
  dql-notebook/          Notebook document model and execution helpers
  dql-charts/            React SVG chart components
  dql-ui/                Shared UI components and theme tokens
  dql-agent/             Ask and agent runtime
  dql-mcp/               MCP server
  dql-slack/             Slack bot
  dql-openlineage/       OpenLineage emitter
  dql-plugin-api/        Plugin API types
  dql-telemetry/         Deprecated, unused
  create-dql-app/        `npx create-zlens-app` scaffolder
docs/                    All documentation
```

---

## Pull Requests

- Keep changes focused on the public ZLens surface.
- Verify current repository state before relying on issues, memory, or roadmap snapshots.
- Add or update tests when behavior changes.
- Update docs or examples when syntax or CLI workflow changes.
- Run `pnpm build && pnpm test` before opening a PR.
- Fill out the PR template completely — especially the "Release Impact" section.

### Commit style

Use conventional commit prefixes:

- `feat:` — new feature or behavior
- `fix:` — bug fix
- `docs:` — documentation only
- `chore:` — build, release, or maintenance

---

## Good First Issues

Look for issues tagged [`good first issue`](https://github.com/duckcode-ai-labs/zlens/issues?q=label%3A%22good+first+issue%22) on GitHub. These are scoped tasks with clear acceptance criteria.

Common contribution areas:

- Adding a new database connector driver in `packages/dql-connectors/`
- Improving error messages from the parser (`packages/dql-core/src/parser/`)
- Extending test coverage for edge cases in governance rules
- Adding examples or improving existing documentation

---

## Versioning

ZLens follows [Semantic Versioning](https://semver.org/):

- **Patch** (`x.y.Z`): bug fixes, documentation, internal improvements
- **Minor** (`x.Y.0`): new features, new commands, new language constructs (backwards-compatible)
- **Major** (`X.0.0`): breaking changes to the language syntax, CLI flags, or public package APIs

The release packages (every `@zlens/*` package in the release list,
`create-zlens-app` and the VS Code extension's `dql-language-support`) are
released together on the same version, starting at `0.1.0`. `datalex-lsp`
versions on its own (currently `0.2.0`) and is not part of the tag release.

---

## Release Readiness

Before treating a change as OSS-ready, review the launch checklist:

- [`docs/oss-readiness-checklist.md`](./docs/oss-readiness-checklist.md)
- [`docs/contribute/releasing.md`](./docs/contribute/releasing.md)

## Shared design contract (host applications that embed ZLens)

ZLens can be embedded by a host application, which reskins it to its global
theme. A small set of names is a **shared contract** hosts depend on — don't
rename them without coordinating: the `data-theme` values
(`paper`/`white`/`obsidian`), the `--bg-*`/`--text-*`/`--accent*`/`--border-*`
vars, and the `dql-theme` storage key (with its cross-tab `storage` listener). A
host's build may run a contract check that fails on a break. See [`AGENTS.md`](AGENTS.md)
for the full list.
