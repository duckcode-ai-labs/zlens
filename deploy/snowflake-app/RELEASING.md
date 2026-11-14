# Releasing the ZLens app for Snowflake

Two application packages, both defined in [`snowflake.yml`](snowflake.yml):

| Package | Distribution | What it is for |
|---|---|---|
| `ZLENS_PACKAGE` | INTERNAL | Development. `snow app run` installs it in development mode in your own account. Never leaves the account |
| `ZLENS` | EXTERNAL | What customers install, through a Marketplace listing. Versions only, never development mode. Snowflake scans every version before it can be released |

Both packages use release channels: `QA` (internal testing, never reviewed by Snowflake), `ALPHA`
(may hold versions whose review is not approved yet) and `DEFAULT` (versions that passed review;
what a listing installs). A version is added to a channel, then that channel's release directive
names the version and patch customers get. Installed apps upgrade to it on their own.

Before the first version of `ZLENS`: Snowflake must approve the provider's security questionnaire
for apps with containers. Until then creating a version fails with error `093197` ("Account is
not allowed to create application package versions...").

## Each release

Replace `<v>` with the ZLens version (for example `0.4.0`), `<n>` with the next app version
(`V1`, `V2`, ...) or use `--patch` for a fix to the current one, and `<repo>` with your image
repository (`/<db>/<schema>/<repo>`).

1. **Build** the image from a clean checkout of the release commit. An image tag is used once:
   a version's images cannot change after it is created.

   ```bash
   docker build --platform linux/amd64 --target snowflake-app \
     --build-arg ZLENS_DRIVERS="snowflake-sdk@^3.4.1" -t zlens-snowflake:<v> .
   ```

2. **Scan** it: fixable critical or high CVEs, or any malware, stop the release.

   ```bash
   deploy/snowflake-app/scan-image.sh zlens-snowflake:<v>
   ```

3. **Push** it to the image repository in the provider account (`snow spcs image-registry login`,
   then `docker tag` and `docker push` as in [README.md](README.md)).

4. **Try it in development mode** from this folder, as the customer's admin would (the steps in
   [app/README.md](app/README.md)): before the person and a database are set, ZLens shows the
   missing steps; then the named person gets the page, anyone else is refused, Test connection signs
   in with the container's token, a query reads the granted tables, and `stop_app()` then
   `start_app()` keeps the project.

   ```bash
   ZLENS_IMAGE=<repo>/zlens:<v> snow app run
   ```

5. **Create the version** in the customer package. A package holds at most two versions that are in no
   release channel: remove old ones first with `ALTER APPLICATION PACKAGE ZLENS DEREGISTER VERSION <old>;`
   (with release channels on, `DROP VERSION` is refused). Snowflake starts its automated security scan:
   `SHOW VERSIONS IN APPLICATION PACKAGE ZLENS` shows `review_status` going from `NOT_REVIEWED` to
   `APPROVED` (or `REJECTED`; Snowflake sends no notice, so check).

   ```bash
   ZLENS_IMAGE=<repo>/zlens:<v> snow app version create <n> --package-entity-id zlens_release \
     --label "ZLens <v>"
   ```

6. **Check a versioned install** in your own account before customers get it: install from the
   package (`CREATE APPLICATION ZLENS_RELEASE_CHECK FROM APPLICATION PACKAGE ZLENS USING VERSION
   <n>`; in the provider's own account this works before the version is in any channel), repeat the
   checks of step 4 on it, then `DROP APPLICATION ZLENS_RELEASE_CHECK CASCADE`.

7. **Release** it once its review is `APPROVED`. A channel holds at most two versions: drop the
   oldest first (`ALTER APPLICATION PACKAGE ZLENS MODIFY RELEASE CHANNEL DEFAULT DROP VERSION <old>;`,
   once no directive names it).

   ```sql
   ALTER APPLICATION PACKAGE ZLENS MODIFY RELEASE CHANNEL DEFAULT ADD VERSION <n>;
   ALTER APPLICATION PACKAGE ZLENS MODIFY RELEASE CHANNEL DEFAULT
     SET DEFAULT RELEASE DIRECTIVE VERSION = <n> PATCH = <patch>;
   ```

## Before the first listing

- Snowflake has approved: the security questionnaire (containers) and the provider profile.
- A version of `ZLENS` with review `APPROVED`, in the `DEFAULT` channel with a release directive.
- A cross-account install through a private listing to a second account works end to end.
- The listing states what the app needs: a paid (non-trial) Snowflake account (trials cannot run
  containers or Cortex without a card); for Ask, Snowflake Cortex with the `SNOWFLAKE.CORTEX_USER`
  grant to the app, and cross-region inference where Claude is not in the account's region.
- Listing fields: title, subtitle, description, categories, business needs, documentation link
  (this folder), the provider's privacy and support links, and usage examples. The app's own
  [README](app/README.md) is what the customer reads after installing.
