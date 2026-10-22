# Find your way around

`npm run notebook` (or `zlens notebook`) opens the **ZLens Workbench** in your
browser at `http://127.0.0.1:3474`. It is a local, single-user app: your work
is saved as files in your project folder.

The workbench opens on **Apps**.

## The left rail

Click **»** at the top of the rail to show the labels. The rail has three
groups.

**Insights**: use what is already built.

| Item | What it is for |
|---|---|
| **Apps** | Dashboards and reports built from saved queries. See [Apps](../apps/index.md). |
| **Ask** | Ask a question in plain English and see how far to trust the answer. See [Ask](../ask/index.md). |

**Build**: make and review analytics.

| Item | What it is for |
|---|---|
| **Notebooks** | SQL and DQL cells, results and notes. See [Notebooks](../notebooks/index.md). |
| **Saved queries** | Reusable, reviewed queries, edited in the saved query editor. See [Saved queries](../blocks/index.md). |
| **Lineage** | Where a number comes from and what uses it. See [Lineage](../lineage/index.md). |

**Govern**: keep the project trustworthy.

| Item | What it is for |
|---|---|
| **Modeling** | Domains, relationships, business terms and skills. See [Modeling and Domain Packages](../datalex-and-dql.md). |
| **Ask observability** | A record of every Ask run. See [How Ask answered](../ask/how-it-answered.md). |
| **Source control** | Review your changes and share them through git. See [Version and diff your work](../notebooks/version-and-diff.md). |
| **Settings** | Project and dbt, **Database**, **AI provider**, agent memory. |

**Help**, at the bottom of the rail, has a short setup guide inside the app.

## Command palette

Press **Cmd+K** (macOS) or **Ctrl+K** to open the command palette. Type to
find a command, such as "New notebook…" or "Go to Lineage".

## Guided Setup

The first time you open a project, and after you upgrade ZLens, the workbench
starts with **Guided Setup**: dbt project, database, AI provider (optional),
then a choice of where to start. Click **Close setup** to skip it. Open it
again from **Settings → Overview → Guided Setup**.

## Themes

Use the theme menu at the top right to switch between **Paper**, **White** and
**Obsidian**.

## What is saved where

| You make | It is saved as |
|---|---|
| A notebook | `notebooks/<name>.dqlnb` (results go in a git-ignored `.run.json` beside it) |
| A saved query | a `.dql` block file under `blocks/` or `domains/<domain>/blocks/` |
| An App | `apps/<app-id>/dql.app.json` and `apps/<app-id>/dashboards/*.dqld`, once you publish it |
| Settings, chats, run history | `.dql/` (git-ignored) |

See [Project layout](../reference/project-layout.md) for the full list.
