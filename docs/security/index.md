# Security

How DuckCode AI Labs Inc builds, checks and supports ZLens, and how the ZLens app for Snowflake keeps a
customer's data in their own account. To report a vulnerability, write to **security@zlens.app**
([SECURITY.md](https://github.com/duckcode-ai-labs/zlens/blob/main/SECURITY.md)).

| Page | What it covers |
|---|---|
| [Secure development](secure-development.md) | Who can change the code, the checks every change passes, how a release is built |
| [Vulnerability management](vulnerability-management.md) | What is scanned and when, fix deadlines by severity, exceptions |
| [Incident response](incident-response.md) | Severities, response times, steps, who is told and when |
| [Threat model](threat-model.md) | The ZLens app for Snowflake: what it protects, where the boundaries are, each threat and its control |
| [CVE exceptions](cve-exceptions.md) | Any known vulnerability we have not fixed yet, and why it is not reachable |

The ZLens app for Snowflake, in short:

- It runs in the customer's own Snowflake account, as a Native App with one container service.
- Snowflake signs every person in before a request reaches ZLens, and ZLens serves only the person the
  customer's admin named.
- It reads only the database the customer grants it, with read-only statements, on its own extra-small
  warehouse.
- AI goes to Snowflake Cortex inside the account. ZLens ships no model files and loads no code or models
  at run time.
- It has no internet access. It asks for no external access integration, and nothing is sent to us.
- Its image is minimal: distroless Node, no shell or package manager, running as a non-root user,
  scanned for CVEs and malware before every release.
