# Cite your team's documents

Ask can read your team's documents, such as Confluence or a wiki, to explain
the terms in a question, and cite the pages under the answer as
**From team documents**. The numbers still come only from governed queries,
and documents never change an answer's trust label.

You set this up by listing MCP servers in `.dql/mcp-servers.json`. That file
is private: the starter project's `.gitignore` keeps it out of git.

## Set up a knowledge source

A server marked `"use": ["knowledge"]` is a **knowledge source**: a
read-only document store (Confluence, a wiki, a notes server) that Ask and
Research may read to explain a question's terms, and cite under the answer.
ZLens reads it with its **own** MCP client — it does not hand the server to a
provider's hosted connector — so it works with every model: Anthropic,
OpenAI, Bedrock, Vertex, Ollama and the subscription CLIs.

```json
{
  "servers": [
    {
      "name": "confluence",
      "label": "Confluence",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "use": ["knowledge"],
      "trusted": true,
      "authorizationTokenEnv": "CONFLUENCE_MCP_TOKEN",
      "knowledge": { "searchTool": "search", "searchArg": "query", "fetchTool": "fetch", "fetchArg": "id" }
    },
    {
      "name": "notes",
      "command": "node",
      "args": ["tools/notes-mcp.mjs"],
      "use": ["knowledge"],
      "trusted": true
    }
  ]
}
```

- **Transport.** Streamable HTTP (`url`, https; plain http only on this
  machine), or stdio (`command`, `args`) for a local server started in the
  project folder.
- **Tools.** ZLens calls exactly two tools: the server's search (default
  `search` with `query`) and its page read (default `fetch` with `id`).
  `knowledge.searchArgs` / `fetchArgs` add fixed arguments (for example a
  site id). `allowedTools` narrows further. Nothing else on the server is
  ever called.
- **Read-only.** A server that marks its search or fetch tool as one that
  writes (`readOnlyHint: false` or `destructiveHint: true`) is refused.
- **Tool gate.** Every search and page read runs through the same tool gate
  as ZLens's other agent tools (a host's `tools` hook sees each call with the
  person asking). A page can be read only if a search in the same answer
  returned it.
- `trusted: true` is required, as for chat servers. `use` defaults to
  `["chat"]`; a server may list both. A knowledge-only server is never
  attached to the chat cell.

**What an answer does with documents.** The governed answer is made first,
exactly as without knowledge. The model then looks up what the documents say
about the question's terms and writes a short note, shown under the answer
as **From team documents** with each page's title and link.

- **Figures come only from governed queries.** Any sentence in the note that
  states a figure is removed, and a sentence in the answer that states a
  figure only a document holds is removed too.
- **Documents never change trust.** A certified answer is certified because
  of its saved query; an answer that needs review still needs review. Citations
  are kept apart from the trust decision.
- **What leaves the machine.** Pages go only to a model on this machine
  (Ollama on a loopback address) unless you allow a server's pages to reach
  a hosted model: add `"hostedModels": true` to its `knowledge` settings.
  `.dql/mcp-servers.json` is private (git-ignored), so this is your own
  choice, per server. When pages are held back, the answer's steps say
  **Team documents not read** and name the servers. Result values never go
  to the knowledge step.

```json
{ "name": "confluence", "url": "https://mcp.atlassian.com/v1/mcp", "use": ["knowledge"], "trusted": true,
  "authorizationTokenEnv": "CONFLUENCE_MCP_TOKEN", "knowledge": { "hostedModels": true } }
```

**Definitions too.** A question that asks what a governed term means ("What
counts as a paid claim?") reads the same documents under the same rules: the
definition comes from the project, the page is cited beside it, no figure
comes from a document and trust is unchanged.

Research reads the same sources after framing the question and lists what
it read as context; context is never used in a verdict. When pages are held
back from a model off this machine, Research's steps say **Team documents
not read**, as Ask's do.

**Who reads what.** Without a host, the project file's servers and tokens
are used, with the model rule above. When ZLens runs inside a host that signs people in (RFC 0010), the
host's `knowledgeSources` hook decides, per person, with that person's own
token; without that hook such a host gets no knowledge sources.

## Give the chat model other MCP servers

When OpenAI or Anthropic is the active [AI provider](../get-started/ai-provider.md),
the same file can also attach trusted remote MCP servers, or OpenAI
connectors, to the notebook and App chat. ZLens still offers its own governed
tools first.

```json
{
  "servers": [
    {
      "name": "github",
      "url": "https://api.githubcopilot.com/mcp/",
      "trusted": true,
      "authorizationTokenEnv": "GITHUB_MCP_TOKEN",
      "allowedTools": ["search_issues"],
      "providers": ["openai", "anthropic"]
    }
  ],
  "connectors": [
    {
      "name": "gdrive",
      "connectorId": "connector_googledrive",
      "trusted": true,
      "authorizationTokenEnv": "GOOGLE_DRIVE_OAUTH_TOKEN",
      "providers": ["openai"]
    }
  ]
}
```

`trusted: true` is required before ZLens attaches a server. Use `providers`
to limit a server to one provider.
