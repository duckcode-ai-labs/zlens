# Claude Desktop

Connect the Claude Desktop app to your ZLens project. Claude Desktop cannot
open your project's files, so everything it learns about the project comes
through the ZLens tools: saved queries, Apps, notebooks, lineage, the semantic layer
and the catalog.

## Before you start

- A ZLens project where `npm exec -- zlens mcp test` ends with `Ready`. See
  [Connect your AI agent](index.md#1-check-the-project).
- The workbench running: `npm run notebook` (or `zlens notebook <project>`).
  Queries go through it.
- Claude Desktop installed and signed in.

## Set it up

From the project folder:

```bash
npm exec -- zlens connect claude-desktop
```

It adds a `dql` entry to Claude Desktop's own config file, for your user,
and keeps any other servers in it:

| System | Config file |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

The entry looks like this on macOS with Node from Homebrew:

```json
{
  "mcpServers": {
    "dql": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "--package=@zlens/cli", "zlens", "mcp", "/path/to/your/project"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
    }
  }
}
```

Claude Desktop starts from the Dock or the Start menu, not from a terminal,
so it does not see the `PATH` where Node is installed. `zlens connect` writes
the full path of the `npx` that sits next to the Node you ran it with, and
puts that folder first on the server's `PATH`, so the server starts the same
way it does in your terminal.

The config holds the path to your project. Connect one project at a time, or
copy the entry under another name (for example `dql-sales`) for a second
project.

## Open Claude Desktop

Quit Claude Desktop completely and open it again. In a new chat, open the
tools menu (search and tools): `dql` is listed with its 27 tools. Claude
Desktop asks before it runs each tool; choose to allow it for the chat or
always.

## What to expect

- *"How has revenue changed by month?"*: Claude routes the question with
  `ask_dql`, runs the certified saved query with `query_via_block`, and labels the
  answer **Certified**.
- *"What is the average order value by customer type?"*: no certified saved
  query returns that measure, so Claude compiles the semantic metric
  `average_order_value` with `query_semantic_model`, and the answer is labelled
  **From Metrics**, as on the Ask page.
- A question neither answers is run as one read-only query with
  `query_via_metadata` and labelled **AI-Generated (review required)**, with
  the path of the draft saved query ZLens kept.
- *"What Apps do we have, and are their tiles certified?"* uses `list_apps`;
  *"What's in the welcome notebook?"* uses `list_notebooks`. These replace
  opening the files, which Claude Desktop cannot do.
- Claude cannot certify anything; `certify` only checks the rules.

`answer_question` works only when an AI model is set up in ZLens; without one
it returns `modelUnavailable` and Claude answers through `ask_dql` instead.

## Troubleshooting

| What you see | What to do |
|---|---|
| `dql` is missing from the tools menu | Quit Claude Desktop fully (not just the window) and reopen it. Check the config file above holds the `dql` entry. |
| `spawn npx ENOENT` in Claude Desktop's MCP log | Run `npm exec -- zlens connect claude-desktop` again from the project, with the Node you use every day, so the entry gets the full `npx` path. |
| The server starts slowly the first time | `npx` downloads the CLI once. Install it in the project (`npm install`) to skip the download. |
| A tool says `Could not reach the ZLens runtime` | Start the workbench and keep it running. If it runs on another port, add `"ZLENS_RUNTIME_URL": "http://127.0.0.1:<port>"` to the entry's `env`. |
