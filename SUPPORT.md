# Getting help with ZLens

Pick whichever channel matches what you need:

| What you need | Where to go |
|---|---|
| **Ask a question** ("how do I…?", setup help, "is this expected?") | [GitHub Discussions → Q&A](https://github.com/duckcode-ai-labs/zlens/discussions/categories/q-a) |
| **Suggest an idea** or a feature you're not sure about yet | [Discussions → Ideas](https://github.com/duckcode-ai-labs/zlens/discussions/categories/ideas). Ideas we agree on become issues. |
| **Share what you built** with ZLens | [Discussions → Show and tell](https://github.com/duckcode-ai-labs/zlens/discussions/categories/show-and-tell) |
| **File a reproducible bug** | [Open a bug report](https://github.com/duckcode-ai-labs/zlens/issues/new?template=bug_report.yml) |
| **Request a well-defined feature** | [Open a feature request](https://github.com/duckcode-ai-labs/zlens/issues/new?template=feature_request.yml) |
| **Propose a language or schema change** | RFC under [`docs/rfcs/`](docs/rfcs/). See the [template](docs/rfcs/0000-template.md) |
| **Report a security issue** | Follow [SECURITY.md](SECURITY.md) (email security@zlens.app; do **not** open a public issue) |
| **Release news** | [Discussions → Announcements](https://github.com/duckcode-ai-labs/zlens/discussions/categories/announcements) and [GitHub Releases](https://github.com/duckcode-ai-labs/zlens/releases) |
| **DataLex-side governance questions** | [duckcode-ai/DataLex](https://github.com/duckcode-ai/DataLex) |

Not sure whether it's a bug? Start a Q&A discussion. If it turns out to be one, we'll open the issue for you.

When you ask, include your ZLens version (`zlens --version`), your OS and Node version, your warehouse (DuckDB, Snowflake, …), and
the exact command or screen. For Ask and agent answers, the trust label and "How it was answered" help us most.

## Triage SLA

We aim to acknowledge new issues and Q&A discussions within **3 business days** and apply a triage label (`bug`, `enhancement`,
`question`, `needs-info`, `wontfix`) to issues within **7 business days**. The schedule below sets expectations — it is not a hard
guarantee for a small OSS team.

| Severity | First response | Status update | Resolution target |
|---|---|---|---|
| `severity:critical` (broken release, MCP serves wrong data, certified output corrupt) | <24h | every 48h | within 1 week |
| `severity:high` (regression in compile / runtime / lineage) | <72h | weekly | next minor release |
| `severity:normal` | <7 days | as needed | best-effort |
| `severity:low` / `enhancement` | <14 days | quarterly | community PRs welcome |

## What we'll **not** do here

- Discuss closed-source / commercial product details — that's a separate venue.
- Triage issues filed against archived repos (`duckcode-observability`, `duck-code`) — those are unmaintained.
- Provide tax, legal, financial, or compliance advice based on your data — ZLens is a tool; you own the call.
