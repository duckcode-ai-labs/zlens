# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| The latest `0.x` release on npm | Yes |
| The ZLens app for Snowflake: the version on its default release channel | Yes |
| Older releases | No, please upgrade |

Fixes ship in the latest release. We do not back-port to older lines.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing **security@zlens.app**. Include:

1. A description of the vulnerability and its potential impact
2. Steps to reproduce (minimal example preferred)
3. Your contact information for follow-up

We will acknowledge receipt within 2 business days. Confirmed vulnerabilities are fixed within 7 days
(critical), 30 days (high) or 90 days (medium); see [Vulnerability management](docs/security/vulnerability-management.md).
How we build and release, and how the app for Snowflake is protected: [docs/security](docs/security/index.md).

---

## Scope

This security policy applies to the open-source ZLens repository:

- `zlens` and all CLI commands
- `@zlens/core`, `@zlens/dql-compiler`, `@zlens/connectors`, `@zlens/governance`, `@zlens/notebook`, `@zlens/runtime`, `@zlens/dql-lsp`, `@zlens/project`
- The Ask and agent runtime (`@zlens/agent`), including prompts, tool calls, and the SQL it generates
- The MCP server (`@zlens/mcp`) and the Slack bot (`@zlens/slack`)
- The notebook UI (`@zlens/ui`, `@zlens/charts`, and the notebook app)
- The `create-zlens-app` scaffolder
- The `DQL for ZLens` VS Code extension (`dql-language-support`)

Issues in third-party dependencies should be reported upstream to those projects.

---

## Security Considerations for Self-Hosted Use

ZLens runs a local HTTP server when you run `zlens notebook`. By default:

- The server binds to `127.0.0.1` (localhost only)
- No authentication is applied while it is bound to localhost. Binding it to any
  other address (`--host 0.0.0.0` or `ZLENS_HOST`) is refused unless you also set
  `ZLENS_SERVER_TOKEN` (every `/api/` request except `/api/health` then needs
  `Authorization: Bearer <token>`) and `ZLENS_ALLOWED_ORIGINS`
- SQL queries entered in the notebook are executed directly against your configured database connection

**Do not expose the ZLens notebook server to untrusted networks.** The server is designed for local, single-user use. A token protects the API, but it is one shared secret, not per-person access control.

---

## Credential Handling

ZLens reads database credentials from `dql.config.json`. Best practices:

- Do not commit `dql.config.json` if it contains passwords or access tokens
- Use environment variable references where supported: `"password": "${DB_PASSWORD}"`
- Add `dql.config.json` to your `.gitignore` if it contains secrets
