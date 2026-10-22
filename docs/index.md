---
hide:
  - toc
---

# ZLens

**Certified answers on your warehouse.**

ZLens is an open-source analytics workbench. It works on top of your dbt
project, or straight on your database's own tables. You build
**saved queries** (reviewed, reusable queries), turn them into **Apps**, and **Ask**
questions in plain English. Every answer and every tile says how far to trust
it: **Certified**, **Governed**, **Needs review**, or a refusal with the
reason.

Using dbt? ZLens reads your models, tests and lineage. Not using dbt? Start straight from your database.

Everything is a file in your project, so it is reviewed in git like code. ZLens runs on your machine; no hosted account is needed.

{{ clip("overview") }}

## Start here

1. [Quickstart](get-started/index.md): run ZLens on a sample dbt project and
   get your first result in about ten minutes. No dbt?
   [Start from your database](get-started/no-dbt.md).
2. [Ask a question](ask/index.md) and read its trust label.
3. [Certify a saved query](blocks/certify.md) so Ask and Apps can trust it.

## Follow the journey

| | |
|---|---|
| **[Get started](get-started/index.md)** | Install, open the workbench, connect a database and an AI provider, add ZLens to your dbt project or start from your database alone. |
| **[Ask and trust](ask/index.md)** | Certified answers, answers that need review and their saved drafts, refusals with a reason, and how each answer was made. |
| **[Saved queries](blocks/index.md)** | Import SQL, work in the saved query editor, save drafts and certify them. |
| **[Notebooks](notebooks/index.md)** | SQL and DQL cells, results, saving a cell as a saved query, and sharing through git. |
| **[Apps and dashboards](apps/index.md)** | Read an App and its trust labels, build and publish one, ask questions about it. |
| **[Lineage](lineage/index.md)** | From dbt models to saved queries to Apps, in the workbench and the terminal. |
| **[Connect your AI agent](agents/index.md)** | Use ZLens from Claude Code, Codex, Cursor or Claude Desktop over MCP. |
| **[Reference](reference/cli.md)** | CLI, DQL language, file formats, project layout, connectors. |

## How trust works

- **Saving never certifies.** Anything saved, imported or kept from an AI
  answer is a draft until a person clicks **Certify**.
- **Ask tries the most trusted source first**: a certified saved query, then the
  semantic layer, then SQL written by AI, which is marked for review and saved
  as a draft.
- **When ZLens cannot answer safely, it says so**, and why, instead of
  guessing.

## Packages

| Package | What it is |
|---|---|
| [`@zlens/cli`](https://www.npmjs.com/package/@zlens/cli) | The `zlens` command and the workbench |
| [`create-zlens-app`](https://www.npmjs.com/package/create-zlens-app) | Creates a new ZLens project, on a dbt project or a database alone |
| [`@zlens/mcp`](https://www.npmjs.com/package/@zlens/mcp) | The MCP server for AI agents |

[GitHub](https://github.com/duckcode-ai-labs/zlens) ·
[Roadmap](https://github.com/duckcode-ai-labs/zlens/blob/main/ROADMAP.md) ·
[Support](https://github.com/duckcode-ai-labs/zlens/blob/main/SUPPORT.md)
