# Secure development

**Owner:** the DuckCode AI Labs security owner (security@zlens.app). **Reviewed:** with every major release,
and when a check below changes. **Last reviewed:** November 2026.

## Source code

- ZLens's code is in one repository, [duckcode-ai-labs/zlens](https://github.com/duckcode-ai-labs/zlens),
  public under Apache-2.0. Only members of the duckcode-ai-labs GitHub organization can change it.
- Every member signs in with two-factor authentication, which the organization's settings require.
- No one pushes to `main` directly. Every change is a pull request, and `main` is protected: a change
  merges only when every required check passes, and force pushes are refused.
- Before merging, the author reviews the full diff and the check results. Larger changes also get a
  separate automated code review. A second human reviewer will be required once the team has one.

## Checks on every change

Each pull request and every commit to `main` runs these checks in GitHub Actions. The branch protection on
`main` lists the ones a merge waits for.

| Check | What it catches |
|---|---|
| Build and tests on Node 20, 22, 24 and 26 | Regressions, including the security tests for sign-in, read-only SQL, row policies and the app's locks |
| Type checks (every package compiles with TypeScript) | Broken or unsafe types |
| Secret scanning (gitleaks, pinned and checksum-verified) | Keys, tokens or passwords committed by mistake |
| Static analysis (CodeQL, security-extended queries) | Injection, path traversal, unsafe data flows; also runs weekly |
| Dependency audit (`pnpm audit`, production dependencies) | Any high or critical advisory; also runs weekly |
| Snowflake app image: minimal, non-root, Trivy, ClamAV | A shell or package manager in the image, a root user, a fixable critical or high CVE, malware |
| Documentation checks | Links and documented commands that do not exist |

Dependabot raises an alert and a pull request for each vulnerable dependency, and proposes new versions
of the pinned base images and GitHub Actions each week.

## What the ZLens app for Snowflake never does

With `ZLENS_NO_EGRESS=1`, which the app always sets:

- It downloads or installs nothing while it runs. Its database driver is in the image, and there is no
  MetricFlow install and no model download.
- It calls no outside service: no dbt Cloud, and no Slack, email or webhook deliveries.
- It ships no model files. AI calls go to Snowflake Cortex in the customer's account.

The app also asks for no external access integration, so its container has no route to the internet at
all. Tests check each of these refusals (`apps/cli/src/no-egress.test.ts`).

## Building and releasing the app

1. The image is built from a clean checkout of a commit on `main`. It uses the Dockerfile's
   `snowflake-app` stage: distroless Node pinned by digest, a multi-stage build so compilers and package
   managers stay out, running as uid 1000. Layer history is kept.
2. It is scanned with `deploy/snowflake-app/scan-image.sh`. A shell or package manager, a fixable critical
   or high CVE, or any malware stops the release.
3. It goes first to the development application package (`DISTRIBUTION = INTERNAL`). There it is installed
   and tested in a separate consumer account.
4. Only then is it added to the production package (`DISTRIBUTION = EXTERNAL`), where Snowflake's
   automated security scan must pass before the version can be released to customers.

Release steps: [RELEASING.md](https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/RELEASING.md).
Threats and controls: [Threat model](threat-model.md).
