# Cursor

Connect [Cursor](https://cursor.com) to your ZLens project so its agent
answers data questions from certified saved queries first and labels every answer the
way Ask does.

## Before you start

- A ZLens project where `npm exec -- zlens mcp test` ends with `Ready`. See
  [Connect your AI agent](index.md#1-check-the-project).
- The workbench running: `npm run notebook` (or `zlens notebook <project>`).
  Queries go through it.

## Set it up

From the project folder:

```bash
npm exec -- zlens connect cursor
```

It writes `.cursor/mcp.json` in the project, with the ZLens server under the
name `dql`:

```json
{
  "mcpServers": {
    "dql": {
      "command": "npx",
      "args": ["-y", "--package=@zlens/cli", "zlens", "mcp", "/path/to/your/project"]
    }
  }
}
```

Running the command again only rewrites the `dql` entry. `zlens connect
cursor` writes no agent guide; the server's own instructions tell Cursor's
agent how to route questions and report trust labels. To give the guide to
Cursor too, copy the ZLens section that `zlens connect codex` writes into
`AGENTS.md`.

## Open Cursor

Open the project folder in Cursor, then **Cursor Settings → MCP** (Tools &
Integrations in recent versions). `dql` is listed; turn it on if it is off.
It shows 27 tools once it has started.

## What to expect

In the agent chat, ask a question such as *"How has revenue changed by
month?"*.

- The agent routes it with `ask_dql`, runs the certified saved query with
  `query_via_block`, and labels the answer **Certified**.
- A question no certified saved query answers runs as one read-only query with
  `query_via_metadata`, labelled **AI-Generated (review required)**, with the
  path of the draft saved query ZLens kept.
- Cursor asks before it runs a tool unless you allowed it.

`answer_question` works only when an AI model is set up in ZLens; without one
it returns `modelUnavailable` and the agent answers through `ask_dql` instead.

## Troubleshooting

| What you see | What to do |
|---|---|
| `dql` shows an error in MCP settings | Run `npm exec -- zlens mcp test` in the project and fix what it reports, then toggle `dql` off and on. |
| `spawn npx ENOENT` | Cursor started without your shell's `PATH`. Start Cursor from a terminal in the project (`cursor .`), or replace `npx` in `.cursor/mcp.json` with its full path (`which npx`). |
| A tool says `Could not reach the ZLens runtime` | Start the workbench and keep it running. If it runs on another port, add `"env": { "ZLENS_RUNTIME_URL": "http://127.0.0.1:<port>" }` to the entry. |
