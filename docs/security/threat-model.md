# Threat model: the ZLens app for Snowflake

**Owner:** the DuckCode AI Labs security owner. **Reviewed:** with every major release, and whenever an
endpoint, an outside connection or a privilege is added. **Last reviewed:** November 2026.
Architecture: [ARCHITECTURE.md](https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/ARCHITECTURE.md).

## What runs where

- ZLens is a Snowflake Native App installed in the **customer's** account.
  - Its setup script creates the app's own extra-small warehouse and one compute pool.
  - It also creates one container service, `core.zlens`, from the image in the app package.
- The service has **one public endpoint**, `ui` (port 3474), for the ZLens workbench and its API.
  - Snowflake's ingress signs every person in before a request reaches the container.
  - ZLens then serves only the one person the customer's admin named in the app's configuration, and
    refuses anyone else.
- It reads only the database the customer grants to the application, with that grant's privileges,
  on its own warehouse. Every statement carries a `QUERY_TAG` and shows in the customer's query history.
- AI calls go to Snowflake Cortex, in the customer's account, through Snowflake's own APIs.
- ZLens keeps its project on the service's block volume, inside the customer's account. The project
  holds saved queries, certifications, notebooks, Apps and history.
  - Backups are snapshots of that volume.
  - Optionally, an archive goes to a stage the customer grants.
- Nothing is sent to DuckCode AI Labs, and the app shares no logs or events with us.

## Assets

1. The customer's data in the tables and views granted to the app.
2. Questions, prompts, answers and the SQL ZLens writes.
3. The customer's ZLens project: saved queries, certifications, notebooks, Apps.
4. The integrity of ZLens's code and image (the supply chain).
5. Our repository, CI, provider account and image registry credentials.

## Trust boundaries

1. A person's browser → Snowflake's ingress, where Snowflake authenticates.
2. Ingress → the ZLens container.
3. The container → the customer's warehouse and Cortex, inside their account.
4. Our repository and CI → the app package and the image registry, on our side.

## Threats and controls

| # | Threat | Control |
|---|---|---|
| 1 | Someone reaches the workbench or API without signing in | The service's only endpoint is behind Snowflake's ingress, which signs everyone in; ZLens has no logins of its own. ZLens trusts Snowflake's identity header only inside Snowflake (with the service's token file present), and serves only the configured person |
| 2 | The app reads data the customer did not grant | It runs with the application's grants only; the customer grants one database. The manifest asks for only `CREATE COMPUTE POOL`, `BIND SERVICE ENDPOINT`, `CREATE WAREHOUSE` and the `CORTEX_USER` database role |
| 3 | SQL written by AI changes or deletes data | The code checks AI-written SQL before it runs: it must be one `SELECT`/`WITH` statement with no data-changing keyword, or it is refused. The app also holds only the read grants the customer gave it |
| 4 | A prompt injection in data or a question makes the AI leak data or run harmful SQL | Read-only SQL (3); the answer stays in the customer's account; there is no internet route out (5); every answer shows how it was made |
| 5 | Data or prompts leave the customer's account | No external access integration, so the container has no internet route. `ZLENS_NO_EGRESS=1` also turns off every feature that would reach out: dbt Cloud, Slack, email, webhooks |
| 6 | A malicious or compromised dependency or base image | A pinned lockfile; base images pinned by digest; a dependency audit, CodeQL, Trivy and ClamAV on every change; Dependabot alerts; Snowflake's scan of every version |
| 7 | Code or models loaded at run time from outside the package | Nothing installs or downloads while the app runs (no driver installs, MetricFlow, DuckDB extensions or model pulls), checked by tests; ZLens ships no model files |
| 8 | Container escape or misuse of privileges | A minimal distroless image with no shell or package manager, running as uid 1000 (non-root); one small compute pool |
| 9 | No record of what was certified, and when | Each certification is kept with its time, the saved query's owner and a hash of the source it certified |
| 10 | Runaway queries or AI calls use the customer's credits | Every Ask has a deadline and says when it ran out of time. The app's warehouse is extra-small and suspends after 60 seconds idle. ZLens suspends itself after 60 idle minutes |
| 11 | Secrets in logs, images or the repository | Secret scanning on every change; no customer secrets are stored (the app signs in with Snowflake's service token); no credentials in the image |
| 12 | Our account or CI is taken over and a bad version ships | Two-factor sign-in for everyone; releases built from protected `main`; a separate development package; Snowflake's scan of every version. The incident plan rolls back through the release directive ([Incident response](incident-response.md)) |
