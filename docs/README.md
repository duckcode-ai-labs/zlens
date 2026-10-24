# ZLens Documentation

The published docs are at <https://duckcode-ai-labs.github.io/zlens/>. The
same pages are plain Markdown here.

## Get started

1. [Quickstart](./get-started/index.md): run ZLens on a sample dbt project
2. [No dbt? Start from your database](./get-started/no-dbt.md)
3. [Install](./get-started/install.md)
4. [Find your way around](./get-started/workbench.md)
5. [Connect a database](./get-started/connect-database.md)
6. [Set up an AI provider](./get-started/ai-provider.md)
7. [Add ZLens to your dbt project](./get-started/your-dbt-project.md)
8. [Concepts](./get-started/concepts.md)

## Ask and trust

- [Ask a question](./ask/index.md)
- [Answers that need review](./ask/needs-review.md)
- [When Ask refuses](./ask/refusals.md)
- [How Ask answered](./ask/how-it-answered.md)
- [Cite your team's documents](./ask/team-documents.md)

## Saved queries

- [Saved queries](./blocks/index.md)
- [Import SQL](./blocks/import-sql.md)
- [Saved query editor](./blocks/block-studio.md)
- [Save and certify](./blocks/certify.md)

## Notebooks

- [Work in a notebook](./notebooks/index.md)
- [Version and diff your work](./notebooks/version-and-diff.md)

## Apps and dashboards

- [Read an App](./apps/index.md)
- [Build an App](./apps/build.md)
- [Ask about an App](./apps/ask-about-an-app.md)

## Lineage

- [Lineage](./lineage/index.md)

## Connect your AI agent

- [Connect an agent (MCP)](./agents/index.md)
- [MCP tools](./agents/tools.md)

## Reference

- [CLI](./reference/cli.md)
- [DQL language](./reference/language.md)
- [Project layout](./reference/project-layout.md)
- [File formats](./reference/file-formats.md)
- [Connectors](./reference/connectors.md)
- [Semantic layer](./reference/semantic-layer.md)
- [Modeling and Domain Packages](./datalex-and-dql.md)
- [Ask traces](./reference/ask-traces.md)
- [CI with `zlens eval`](./tutorials/05-ci-and-verify.md)
- [Migrate from other tools](./guides/migrate.md)
- [Workbook to dashboard](./migrations/workbook-to-dashboard.md)
- [Compatibility](./reference/compatibility.md)
- [Troubleshooting](./guides/troubleshooting.md)
- [FAQ](./guides/faq.md)

## Architecture

- [Overview](./architecture/overview.md)
- [Graduated trust](./architecture/graduated-trust.md)
- [Answer flow](./agentic-answer-flow.md)
- [Agentic loop](./architecture/agentic-loop/README.md)
- [Lineage model](./architecture/lineage-model.md)
- [App AI](./architecture/generative-app-builder.md)
- [dbt integration](./architecture/dbt-integration.md)
- [OpenLineage](./architecture/openlineage.md)
- [Plugin API](./architecture/plugin-api.md)
- [Hosted servers](./guides/hosted-servers.md)

## Contributing

- [Current ZLens truth](./contribute/current-dql-truth.md)
- [OSS delivery orchestration](./contribute/delivery-orchestration.md)
- [Repo layout](./contribute/repo-layout.md)
- [Testing](./contribute/testing.md)
- [Releasing](./contribute/releasing.md)
- [Docs audit](./contribute/docs-audit.md)
- [OSS readiness checklist](./oss-readiness-checklist.md)

The product was called DQL before it was renamed ZLens; DQL is now the name of
its query language. Design records written before the rename (the
[RFCs](./rfcs/), the [domain-context specs](./specs/dql-2-domain-context/),
[performance plans](./performance/), the current-truth snapshot and the
readiness checklist) still use "DQL" for the product and the old package and
command names.

## Archive

Older pages, kept so links keep working: [About the archive](./archive.md).

---

Bug or feature request? [Open an issue](https://github.com/duckcode-ai-labs/zlens/issues).
