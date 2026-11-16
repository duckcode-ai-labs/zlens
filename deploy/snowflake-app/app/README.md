# ZLens

Governed analytics in your Snowflake account: a semantic layer, certified answers with trust labels,
and Apps. This free app serves **one person**. ZLens runs here, reads only what you grant it, and
keeps its projects on a volume in your account.

When you get the app, Snowflake gives it what it needs to run: a small compute pool, its own address,
and an extra-small warehouse for its queries. ZLens starts by itself.

In the SQL below, replace `ZLENS_APP` with your app's name (Snowsight shows it under **Apps**), and
`MY_DB`, `MY_SCHEMA` with yours. Until setup is done, ZLens's own page shows these lines with your
app's name filled in.

## Quick start

Run these in Snowsight as ACCOUNTADMIN, or as the role that installed the app.

1. **Name the person who uses ZLens.** Open **Apps** in Snowsight's left menu, then this app, then its
   **Configurations** tab. Pick a warehouse at the top of the page first (Snowsight needs one to save),
   then select **Review**, enter that person's Snowflake user name, and **Save**. Or in SQL:

   ```sql
   ALTER APPLICATION ZLENS_APP SET CONFIGURATION ZLENS_USER VALUE = 'THEIR_USER';
   ```

2. **Grant one database.** Repeat the schema lines for each schema ZLens should read in that database:

   ```sql
   GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;
   GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
   GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
   GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
   ```

3. **Let that person open it.** The role that installed the app can open it already. For another role,
   add it on the app's **Access management** page, or:

   ```sql
   GRANT APPLICATION ROLE ZLENS_APP.app_user TO ROLE THEIR_ROLE;
   ```

4. **Let ZLens ask Claude** (optional). If the app's **Permissions** tab does not show `CORTEX_USER`
   as granted yet:

   ```sql
   GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;
   ```

5. **Open it.** Press **Launch app** on the app's page in Snowsight (next section).

## The first open: what to expect

- **Press Launch app.** It opens a small ZLens page inside Snowsight. If ZLens has stopped (it stops
  itself after 60 idle minutes), the page starts it and shows the time so far: a start takes
  about 2 to 3 minutes. Once Snowflake reports ZLens ready, the page shows **Open ZLens** and ZLens's
  address. It never offers the address before then.
- **Snowflake asks you to sign in again.** Open ZLens opens ZLens's own address in a new tab, and
  Snowflake signs you in there too. The sign-in page names it `SNOWSERVICES_INGRESS`. This is
  Snowflake's own sign-in. If your browser blocks the new tab, copy the address from the page.
- **Close the launcher tab** once ZLens is open. While it stays open it keeps the app's small
  warehouse running (about 15 minutes after its last use).
- **Not set up yet, or someone else:** until step 1 is done the page shows the setup steps, and it
  tells anyone but the named user that ZLens serves someone else, before starting anything.
- **The address on its own** (a bookmark, or a link shared from Snowsight) does not wait: opened while
  ZLens is stopped or starting, Snowflake shows a plain page that reads
  `"service is not yet running (serviceStatus=PENDING)"`, and each reload asks you to sign in again.
  Start from **Launch app** instead.
- **In SQL,** this does the same as the page: it starts ZLens if it has stopped, waits until it is
  ready (the call can run for up to 4 minutes), and then gives the address:

  ```sql
  CALL ZLENS_APP.app_public.app_url();
  ```

- **Before a demo or a meeting,** start ZLens a few minutes ahead:

  ```sql
  CALL ZLENS_APP.app_public.start_app();
  ```
- **People limited to Streamlit:** an account that allows some users only Streamlit pages
  (`ALLOWED_INTERFACES`) lets them see the launcher, but not open ZLens itself.

Until steps 1 and 2 are done, whoever opens ZLens sees which of them is still missing. ZLens picks up
changes within a minute, without a restart. Anyone but the named user is told the app is set up for
one person.

## What ZLens does first

Once it has the database, ZLens reads every schema in it the app can see, then drafts the models
(entities, their keys and the joins between them) from those tables. A strip at the top says so while
it runs, in a minute or two, then points to the drafts in **Modeling**. Nothing is saved until you
review them.

**Tables added later.** The grants in step 2 cover the tables and views that exist when you run them.
After you add tables or schemas, run those grant lines again for them, then in ZLens open
**Settings » Database » Apply and synchronize**.

## AI: Claude through Snowflake Cortex

- **Model.** ZLens asks Anthropic's **Claude Sonnet 5.5** (Cortex model `claude-sonnet-5-5`) through
  Snowflake Cortex, inside Snowflake. **Settings » AI provider** shows the model in use; its advanced
  fields can name another Claude model that Cortex offers in your account.
- **How it reaches Cortex.** Through the Cortex REST API, signed in with the app's own Snowflake token.
  Where Snowflake does not allow the REST API for the account, ZLens asks Cortex through SQL instead
  (`AI_COMPLETE`, in the app's own Snowflake session). **Settings » AI provider » Test** says which one
  answers.
- **Search by meaning.** ZLens finds the tables, columns and metrics a question means, not only the
  ones that share its words, with Cortex embeddings (`AI_EMBED`, model `snowflake-arctic-embed-l-v2.0`),
  inside your account. Indexing costs about a cent of Snowflake credits for a small project (about
  $0.35 for one with hundreds of tables, the first time; after that only new text is embedded). Turn
  it off in **Settings » AI provider » Search**.
- **Without `CORTEX_USER`** (step 4), Ask is off. Everything else works.

## Operations

### Stopping and starting

After 60 minutes with no one using it, ZLens stops by itself. Its projects are kept, and opening it
again starts it. Its compute pool suspends 10 minutes after that.

Stop it now:

```sql
CALL ZLENS_APP.app_public.stop_app();
```

Start it without opening it:

```sql
CALL ZLENS_APP.app_public.start_app();
```

Its address. When ZLens is stopped this starts it, and it waits until ZLens is ready (up to 4
minutes) before it answers:

```sql
CALL ZLENS_APP.app_public.app_url();
```

The launcher page (**Launch app**) uses two short calls instead, so it can show progress: the first
reads ZLens's state, its address and the person it serves, and starts nothing; the second starts a
stopped ZLens and returns at once. Any user of the app may call them:

```sql
CALL ZLENS_APP.app_public.launcher_status();
CALL ZLENS_APP.app_public.launcher_start();
```

### Backups

ZLens backs up its projects once a day, as it stops for the day, and keeps the last 7. They are listed
in **Settings » Backups**, or:

```sql
CALL ZLENS_APP.app_public.backups();
```

Take a backup now (ready in about a minute):

```sql
CALL ZLENS_APP.app_public.back_up_now();
```

Put one back, with a name from the list. ZLens stops and starts again in about three minutes.
Snowflake keeps the replaced volume for 7 days (a `SYS_BACKUP_ON_DELETE...` backup), so a restore can be
undone the same way:

```sql
CALL ZLENS_APP.app_public.restore_backup('<name>');
```

These backups are inside the app: **uninstalling it removes them**. To keep a copy that outlives the
app, give ZLens a stage of your own and name it on the **Configurations** tab ("Stage for ZLens
backups", as `MY_DB.MY_SCHEMA.ZLENS_BACKUPS`):

```sql
CREATE STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS;
GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;
GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION ZLENS_APP;
```

ZLens then copies its projects there once a day when something changed (`zlens-<app>-<date>.tar.gz`,
the last 14 kept). A new install whose project is empty offers to restore the newest one.

### History

Every time a saved query, App or notebook is saved in ZLens, ZLens keeps that version, with the Snowflake
user who saved it (an answer Ask drafted shows as "AI (Ask)" with the person who asked). There is nothing
to commit. The **History** page in ZLens's left bar lists every change; each saved query, App and notebook
has a **History** tab to compare two versions and restore one. Restoring saves the old version as the next
version, as a draft: certified versions and their receipts never change, and certifying stays its own step.
Removed items stay in History and can be restored while the app is installed.

History is kept inside the app, on its volume in your account, with no Git program and no outside
connection; the backups above copy it with the projects. **Settings** shows how much room it takes.

ZLens also copies a log of the changes, without any SQL, values or file content, to a view the
`app_admin` role can read. It is written in batches while ZLens's warehouse is already running, and as
ZLens stops for the day:

```sql
SELECT changed_at, changed_by, item, kind, version, change, certified
FROM ZLENS_APP.app_public.history
ORDER BY changed_at DESC;
```

If ZLens cannot write this log, History itself keeps working and ZLens logs one warning.

### What it costs to run

The app is free. Snowflake bills your account for what it uses:

- its compute pool: one `CPU_X64_XS` node while ZLens runs (Snowflake's rate is about 0.06 credits an
  hour), and nothing once it has stopped and the pool has suspended;
- its warehouse: extra-small, and it suspends after 60 seconds with no queries;
- Cortex: the questions asked, and search by meaning.

## Privileges

The app asks for three account privileges, each shown on its **Permissions** tab: `BIND SERVICE
ENDPOINT` (its own address), `CREATE COMPUTE POOL` (one small pool) and `CREATE WAREHOUSE` (its own
extra-small warehouse), plus the `SNOWFLAKE.CORTEX_USER` database role for Claude. It creates no
listings, shares or external access integrations. Its one Streamlit page, the launcher that **Launch
app** opens, runs on that same warehouse and calls only the app's own procedures
`app_public.launcher_status()` and `app_public.launcher_start()`; it reads none of your data.

## What ZLens reaches, sends, stores and logs

- **Endpoints.** One: `ui` (port 3474), ZLens's web page and its API, at the address the launcher page and `app_url()` give.
  Snowflake signs people in before any request reaches it, and ZLens serves only the user named on
  the Configurations tab. There is no other way in.
- **Internet.** None. The app asks for no external access integration, and ZLens runs with downloads,
  installs and update checks turned off: everything it runs is in the app's image, and it loads no code or
  models at run time. It calls no outside service (no dbt Cloud, no Git repository, no MCP servers or
  hosted connectors; no Slack, email or webhook deliveries).
  Nothing is sent to the app's provider.
- **Your data.** ZLens reads table and column descriptions and runs read-only queries, as the app, on only
  the database you granted, with its own warehouse. Every query carries a `QUERY_TAG` and shows in your `QUERY_HISTORY`.
- **AI.** Questions go to Claude (`claude-sonnet-5-5`) through Snowflake Cortex, inside Snowflake. A prompt
  holds the question, table and column names, metric definitions, and sometimes rows of a query result.
  Cortex may process it in another Snowflake region if your account allows cross-region inference. The
  app's provider never receives prompts or replies, and trains nothing on them.
- **Stored.** On the app's 10Gi block volume in your account: ZLens's project (connection settings,
  metrics, notebooks, Apps), every saved version of its saved queries, Apps and notebooks (History), the
  questions asked with their answers and SQL, run history, cached descriptions of your tables, and backups
  of the project from before each upgrade. In the app's own `core.history_log` table: the change log above. It stays until the app is
  uninstalled; uninstalling deletes it.
- **Logged.** Start-up messages, warnings and errors, to your account's event table if you have one.
  Questions, SQL and query results are not logged.

How every part connects: [ARCHITECTURE.md](https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/ARCHITECTURE.md).
