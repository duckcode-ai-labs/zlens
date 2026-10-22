# Version and diff your work

Notebooks, saved queries and Apps are plain text files, so git is how you review
and share them. ZLens adds a **Source control** page for people who do not
use git every day, and a semantic diff for people who do.

## Share your work from the workbench

1. In the left rail, under **Govern**, click **Source control**.
2. The left side lists changed files in two groups: **Included** (part of your
   next change) and **Needs review**. Click a file to see what changed. Use
   **Include**, **Remove** or **Discard** on each file.
3. The **Share your work** panel walks you through four steps:
    1. **Pick what to share**.
    2. **Describe your change** in plain words, or click **Write it for me from
       the changes**.
    3. **Share to your branch**: click **Share N changes**.
    4. **Ask for review**: click **Open review request**. When it is open, you
       see **Review request opened** and **View on GitHub**.

At the top, the branch menu has **Create new branch…**, and **Get updates** and
**Send** bring in the team's changes and send yours. For the whole flow
(connecting your own repository, sending as a branch, pull requests, and what
happens when a file changed on both sides), see
[Share your work with your team](share-with-your-team.md).

If the project is not a git repository yet, the page offers **Initialize Git
for this project**. With no remote, **Add remote** asks for the
**Remote URL (origin)**.

## What goes into git

| Committed | Kept out of git |
|---|---|
| `.dql` block files (saved queries) and their companion YAML | `.run.json` results |
| `.dqlnb` notebooks | `.dql/` (settings, chats, caches, private work) |
| Published Apps in `apps/` | `dql-manifest.json` (rebuilt by `zlens compile`) |
| `dql.config.json` | DuckDB files, `node_modules/` |

A notebook's results go in `<notebook>.run.json` beside it. When you reopen
the notebook, cells show their last results with a `cached` chip, without
running the queries again.

## See what changed in a saved query or notebook

`git diff` shows changed characters. `zlens diff` shows what changed in
meaning:

```bash
zlens diff blocks/finance/revenue_by_segment.dql     # against the last commit
zlens diff before.dql after.dql                      # two files
```

Example output:

```text
~ block "Top customers by lifetime spend"
    query: select customer_name, … limit 10 → select customer_name, … limit 20
    visualization.chart: "table" → "bar"
```

`zlens diff` exits with code 1 when there are differences, like `git diff`.

## Keep files in one canonical format

ZLens writes files in a canonical format, so saving an unchanged notebook does
not create a diff. To check or fix a file by hand:

```bash
zlens fmt blocks/finance/revenue_by_segment.dql            # format in place
zlens fmt --check blocks/finance/revenue_by_segment.dql    # exit 1 if it needs formatting
```

`zlens fmt` takes one file at a time. To check or upgrade every file in the
project:

```bash
zlens migrate format --check    # report files that would change
zlens migrate format            # rewrite them
```

## Prepare work for sharing

`zlens promote` removes local run state and UI state from a file before you
share it:

```bash
zlens promote notebook notebooks/customer_orders.dqlnb --to shared
zlens promote app <app-id> --to shared
```

## Check the project in CI

See [CI and zlens verify](../tutorials/05-ci-and-verify.md).
