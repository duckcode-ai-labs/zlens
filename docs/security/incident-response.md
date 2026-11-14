# Incident response

**Applies to:** the ZLens app for Snowflake, ZLens open source, ZLens Enterprise, zlens.app, and our source,
build and release systems. **Owner:** the DuckCode AI Labs security owner, who leads every incident.
**Report to:** security@zlens.app. **Tested:** at least once a year with a tabletop exercise.
**Last reviewed:** November 2026.

## What counts as an incident

Any event that could affect the confidentiality, integrity or availability of ZLens or of a customer's
data. For example:

- a vulnerability that is being exploited in a released ZLens version
- a malicious or compromised dependency or base image
- a leaked credential: the repository, CI, the Snowflake provider account, or the image registry
- unauthorized access to the source repository, CI or the Snowflake provider account
- a ZLens bug that exposes a customer's data, or sends it out of their Snowflake account
- a Snowflake security scan finding that points to a real vulnerability

## Severity and response times

| Severity | Example | Acknowledge | Contain | Tell customers and Snowflake |
|---|---|---|---|---|
| **1, Critical** | Customer data exposed; a vulnerability being exploited; the provider account or CI taken over | 1 hour | 24 hours | First notice within 24 hours, then daily |
| **2, High** | An exploitable high vulnerability not known to be used; a leaked credential with no misuse seen | 4 hours | 72 hours | Within 72 hours, if customers are affected |
| **3, Medium** | A limited-impact vulnerability; suspicious activity under investigation | 1 business day | 7 days | In the release notes |
| **4, Low** | Hardening or informational findings | 3 business days | Next release | Not needed |

Legal notification deadlines, such as GDPR's 72 hours, apply on top of these.

## Steps

1. **Report.** Anyone who suspects an incident writes to security@zlens.app.
2. **Triage.** The incident lead sets the severity, opens a private incident record and starts a timeline.
3. **Contain.** Rotate and revoke affected credentials, and disable compromised accounts. For the
   Snowflake app, point the release directive back to the last good version or patch, which every
   installed app follows. Pause the listing if needed, and block a malicious dependency.
4. **Investigate.** Find the cause and the scope: which versions, which customers, what data. Sources
   are CI logs, the repository's audit log and the provider account's history. A customer's own logs are
   used only if they choose to share them.
5. **Fix.** Ship a fixed version or patch. It is scanned like every release
   ([Secure development](secure-development.md)) and must pass Snowflake's scan, and the release
   directive then moves to it.
6. **Notify.** Tell affected customers through their listing contact and by email, and Snowflake through
   a support case or the Marketplace Operations contact in Provider Studio, within the times above.
   Say what happened, what is affected, what we did and what the customer should do.
7. **Recover.** Confirm the fix is installed, and watch for a repeat.
8. **Review.** Within 10 business days of closing a severity 1 or 2 incident, write a blameless review
   with the root cause and follow-up actions, and track each action to completion.

## Records

Incident records, timelines and reviews are kept for at least 3 years.
