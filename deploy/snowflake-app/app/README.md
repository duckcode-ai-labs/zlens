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

5. **Open it** with **Launch app** on the app's page (it opens a new window). Read the next section
   first: the first open takes a few minutes.

## The first open: what to expect

- **Snowflake asks you to sign in again.** ZLens has its own address, and Snowflake signs you in there
  too. The sign-in page names it `SNOWSERVICES_INGRESS`. This is Snowflake's own sign-in.
- **Then a short message while ZLens starts.** Until ZLens is ready, Snowflake shows a plain page that
  reads `"service is not yet running (serviceStatus=PENDING)"`. Snowflake serves that page, not ZLens.
- **How long.** When ZLens stopped after a quiet spell, it takes about 2 minutes. Right after
  install, or when its compute pool stopped too (about 70 minutes or more with no one using ZLens), it
  takes 5 to 15 minutes.
- **Do not reload again and again.** Each reload sends you back to Snowflake's sign-in. Wait a few
  minutes, then reload once.
- **Or ask first.** This says whether ZLens is starting, with the wait, and gives the address once it
  is ready:

  ```sql
  CALL ZLENS_APP.app_public.app_url();
  ```

- **Before a demo or a meeting,** start ZLens 15 minutes ahead:

  ```sql
  CALL ZLENS_APP.app_public.start_app();
  ```

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

- **Model.** ZLens asks Anthropic's **Claude Sonnet 5** (Cortex model `claude-sonnet-5`) through
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

Its address, or how long until it is ready:

```sql
CALL ZLENS_APP.app_public.app_url();
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
listings, shares or external access integrations.

## What ZLens reaches, sends, stores and logs

- **Endpoints.** One: `ui` (port 3474), ZLens's web page and its API, at the address `app_url()` returns.
  Snowflake signs people in before any request reaches it, and ZLens serves only the user named on
  the Configurations tab. There is no other way in.
- **Internet.** None. The app asks for no external access integration, and ZLens runs with downloads,
  installs and update checks turned off: everything it runs is in the app's image, and it loads no code or
  models at run time. It calls no outside service (no dbt Cloud; no Slack, email or webhook deliveries).
  Nothing is sent to the app's provider.
- **Your data.** ZLens reads table and column descriptions and runs read-only queries, as the app, on only
  the database you granted, with its own warehouse. Every query carries a `QUERY_TAG` and shows in your `QUERY_HISTORY`.
- **AI.** Questions go to Claude (`claude-sonnet-5`) through Snowflake Cortex, inside Snowflake. A prompt
  holds the question, table and column names, metric definitions, and sometimes rows of a query result.
  Cortex may process it in another Snowflake region if your account allows cross-region inference. The
  app's provider never receives prompts or replies, and trains nothing on them.
- **Stored.** On the app's 10Gi block volume in your account: ZLens's project (connection settings,
  metrics, notebooks, Apps), the questions asked with their answers and SQL, run history, cached
  descriptions of your tables, and backups of the project from before each upgrade. It stays until the app is
  uninstalled; uninstalling deletes it.
- **Logged.** Start-up messages, warnings and errors, to your account's event table if you have one.
  Questions, SQL and query results are not logged.

How every part connects: [ARCHITECTURE.md](https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/ARCHITECTURE.md).
