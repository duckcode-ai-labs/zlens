# Claude Code

Connect [Claude Code](https://claude.com/claude-code) to your ZLens project so
it answers data questions from certified blocks first and labels every answer
the way Ask does.

## Before you start

- A ZLens project where `npm exec -- zlens mcp test` ends with `Ready`. See
  [Connect your AI agent](index.md#1-check-the-project).
- The workbench running in another terminal: `npm run notebook` (or
  `zlens notebook <project>`). Queries go through it.
- Claude Code installed and signed in (`claude --version`).

## Set it up

From the project folder:

```bash
npm exec -- zlens connect claude-code
```

It writes two files in the project:

- `.mcp.json`, with the ZLens server under the name `dql`:

    ```json
    {
      "mcpServers": {
        "dql": {
          "command": "npx",
          "args": ["-y", "--package=@zlens/cli", "zlens", "mcp", "/path/to/your/project"],
          "alwaysLoad": true
        }
      }
    }
    ```

    `alwaysLoad` makes Claude Code load the ZLens tools at the start of every
    session instead of searching for them.

- A ZLens section in `CLAUDE.md` that tells Claude how to route questions,
  which tool serves which feature, and how to report trust labels. It names
  only tools the server offers by default.

Running the command again only rewrites the ZLens entry and section.

## Open Claude Code

Start Claude Code in the project folder:

```bash
claude
```

The first time, Claude Code asks whether to use the `dql` server from this
project's `.mcp.json`; approve it. Then run `/mcp`: `dql` is listed as
connected, with 27 tools.

## What to expect

Ask a question, for example *"How has revenue changed by month?"*.

- Claude calls `inspect_dql_project`, then `ask_dql`. When a certified block
  answers the question, it runs it with `query_via_block` and labels the
  answer **Certified**, citing the block.
- For a question no certified block answers, for example *"Which store
  locations had the most revenue in 2025?"*, it calls
  `inspect_metadata_context` and runs one read-only query with
  `query_via_metadata`. The answer is labelled **AI-Generated (review
  required)** and names the draft block ZLens saved under `blocks/_drafts/`.
- When the project cannot answer (for example a metric it does not have),
  Claude says what is missing instead of guessing.
- *"Does the monthly_revenue block pass the certification rules?"* runs
  `certify`, which runs Block Studio's check through the workbench and changes
  nothing. Claude cannot certify; a person does, in Block Studio or with
  `zlens certify --from-draft`.
- *"What Apps do we have and are their tiles certified?"* uses `list_apps`;
  *"Draft an App for beverage performance"* uses `build_dql_app`, which
  starts an App Studio draft and returns a link that opens it at the Data
  step. Nothing is written to `apps/` until you publish from App Studio.

Claude Code asks before it runs a tool unless you allow it. To allow every
ZLens tool for the session, answer "don't ask again" for `dql`, or add
`mcp__dql` to your allowed tools.

`answer_question` (ZLens answers by itself, like the Ask page) works only when
an AI model is set up in ZLens. Without one it returns `modelUnavailable`, and
Claude answers through `ask_dql` instead; Claude is the model in that case.

## Run it without the interactive prompt

`claude -p` does not show the approval prompt, so a project server that was
never approved does not load. Pass the config and allow the tools:

```bash
claude -p "How has revenue changed by month?" \
  --mcp-config .mcp.json --allowedTools mcp__dql
```

## Troubleshooting

| What you see | What to do |
|---|---|
| `/mcp` shows `dql` as failed | Run `npm exec -- zlens mcp test` in the project and fix what it reports. The first start downloads the CLI with `npx`, which can take a minute. |
| A tool says `Could not reach the ZLens runtime` | Start the workbench (`npm run notebook`) and keep it running. If it runs on another port, set `ZLENS_RUNTIME_URL` in the `dql` entry's `env`. |
| A tool says `did not answer` | The workbench is busy or stuck; check its terminal. `ZLENS_MCP_RUNTIME_TIMEOUT_MS` sets the wait. |
| `answer_question` returns `modelUnavailable` | Expected without an AI model in ZLens. Claude uses `ask_dql` instead, or set up a provider in the workbench (Settings → AI provider). |
