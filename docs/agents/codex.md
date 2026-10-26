# Codex

Connect [Codex](https://developers.openai.com/codex) to your ZLens project so it
answers data questions from certified saved queries first and labels every answer the
way Ask does.

{{ video("agt3-codex-cursor") }}

## Before you start

- A ZLens project where `npm exec -- zlens mcp test` ends with `Ready`. See
  [Connect your AI agent](index.md#1-check-the-project).
- The workbench running in another terminal: `npm run notebook` (or
  `zlens notebook <project>`). Queries go through it.
- Codex installed and signed in.

## Set it up

From the project folder:

```bash
npm exec -- zlens connect codex
```

It writes two files in the project:

- `.codex/config.toml`, with the ZLens server under the name `dql`:

    ```toml
    # BEGIN DQL MCP
    [mcp_servers.dql]
    command = "npx"
    args = ["-y", "--package=@zlens/cli", "zlens", "mcp", "/path/to/your/project"]
    startup_timeout_sec = 60
    tool_timeout_sec = 600
    # END DQL MCP
    ```

    Codex waits 10 seconds for a server to start and 60 seconds for a tool by
    default. The first start downloads the CLI with `npx`, and
    `answer_question` waits for a model, so both limits are raised.

- A ZLens section in `AGENTS.md` that tells Codex how to route questions,
  which tool serves which feature, and how to report trust labels. It names
  only tools the server offers by default.

Running the command again only rewrites the ZLens block and section.

## Open Codex

Codex reads a project's `.codex/config.toml` only when you trust the project.
Open the project folder in Codex and trust it when asked. Then
`codex mcp list`, run in the project folder, shows `dql` as enabled.

## Approvals

Every ZLens tool says whether it is read-only. With Codex's default approval
mode (`auto`), Codex runs ZLens tools without asking: none of them deletes
anything or certifies anything, and the ones that write only save drafts.

To be asked before any tool that saves a draft, add this line to the `dql`
block:

```toml
default_tools_approval_mode = "writes"
```

`"prompt"` asks before every call. In `codex exec` nobody can answer a prompt,
so a tool that needs an approval fails there; keep `auto` for scripted runs.

## What to expect

Ask a question, for example *"How has revenue changed by month?"*.

- Codex calls `inspect_dql_project`, then `ask_dql`. When a certified saved query
  answers the question, it runs it with `query_via_block` and labels the
  answer **Certified**, citing the saved query.
- For a question no certified saved query answers, for example *"Which store
  locations had the most revenue in 2025?"*, it calls
  `inspect_metadata_context` and runs one read-only query with
  `query_via_metadata`. The answer is labelled **AI-Generated (review
  required)** and names the draft saved query ZLens kept.
- When the project cannot answer, Codex says what is missing, or asks you to
  pick a definition, instead of guessing.
- Lineage (`lineage_impact`), joins (`resolve_analytical_path`,
  `explain_relationship_proof`), certification checks (`certify`), Apps
  (`list_apps`, `build_dql_app`) and notebooks (`list_notebooks`) work the
  same way. Codex cannot certify; a person does, in the saved query editor or with
  `zlens certify --from-draft`.

`answer_question` (ZLens answers by itself, like the Ask page) works only when
an AI model is set up in ZLens. Without one it returns `modelUnavailable`, and
Codex answers through `ask_dql` instead.

## Run it from a script

```bash
codex exec "Which store locations had the most revenue in 2025?"
```

Run it in the trusted project folder, with the workbench running.

## Troubleshooting

| What you see | What to do |
|---|---|
| `codex mcp list` does not show `dql` | Trust the project in Codex, or run the command in the project folder. |
| `MCP tool call requires approval, but approval policy is never` | You set `default_tools_approval_mode` to `"writes"` or `"prompt"` and ran `codex exec`. Use `auto` for scripted runs. |
| `dql` fails to start | Run `npm exec -- zlens mcp test` in the project and fix what it reports. |
| A tool says `Could not reach the ZLens runtime` | Start the workbench (`npm run notebook`) and keep it running. If it runs on another port, add `env = { ZLENS_RUNTIME_URL = "http://127.0.0.1:<port>" }` to the `dql` block. |
| `answer_question` returns `modelUnavailable` | Expected without an AI model in ZLens. Codex uses `ask_dql` instead, or set up a provider in the workbench. |
