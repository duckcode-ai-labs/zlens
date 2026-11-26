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

Run these in Snowsight as ACCOUNTADMIN, or as the role that installed the app. Where a step shows
several lines, run each line, or select them all and press **Run**: Snowsight's Run runs only the
statement at the cursor.

1. **Name the person who uses ZLens.** Open **Apps** in Snowsight's left menu, then this app, then its
   **Configurations** tab. Pick a warehouse at the top of the page first (Snowsight needs one to save),
   then select **Review**, enter that person's Snowflake user name, and **Save**. When it is saved, the
   tab shows a green **Configured** badge with the name. If it still shows **Review**, open Review and
   Save again. Or in SQL:

   ```sql
   ALTER APPLICATION ZLENS_APP SET CONFIGURATION ZLENS_USER VALUE = 'THEIR_USER';
   ```

2. **Grant the data ZLens may read.** Repeat the schema lines for each schema ZLens should read, and the
   database line for each database (ZLens reads every database granted to it; you choose the schemas
   it reads when you open it):

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

## Try it on Snowflake's sample data

ZLens ships no data. To try it without your own tables, copy four tables of Snowflake's TPC-H sample
data into a database you own (about 1.7 million rows), then grant that database instead of step 2.

1. **Copy the sample tables.** Select all the lines, then press **Run**:

   ```sql
   CREATE DATABASE IF NOT EXISTS ZLENS_SAMPLE COMMENT = 'ZLens: copy of TPC-H SF1 sample data';
   CREATE SCHEMA IF NOT EXISTS ZLENS_SAMPLE.TPCH;
   CREATE OR REPLACE TABLE ZLENS_SAMPLE.TPCH.REGION   AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.REGION;
   CREATE OR REPLACE TABLE ZLENS_SAMPLE.TPCH.NATION   AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.NATION;
   CREATE OR REPLACE TABLE ZLENS_SAMPLE.TPCH.CUSTOMER AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.CUSTOMER;
   CREATE OR REPLACE TABLE ZLENS_SAMPLE.TPCH.ORDERS   AS SELECT * FROM SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.ORDERS;
   ```

   No `SNOWFLAKE_SAMPLE_DATA` database in your account? Create it from Snowflake's sample share first:

   ```sql
   CREATE DATABASE SNOWFLAKE_SAMPLE_DATA FROM SHARE SFC_SAMPLES.SAMPLE_DATA;
   ```

2. **Grant it to ZLens.** Select all the lines, then press **Run**:

   ```sql
   GRANT USAGE ON DATABASE ZLENS_SAMPLE TO APPLICATION ZLENS_APP;
   GRANT USAGE ON SCHEMA ZLENS_SAMPLE.TPCH TO APPLICATION ZLENS_APP;
   GRANT SELECT ON ALL TABLES IN SCHEMA ZLENS_SAMPLE.TPCH TO APPLICATION ZLENS_APP;
   ```

3. **Open ZLens.** It asks which schemas to read. TPCH holds 4 tables, so it is ticked already: press
   **Read these tables**. In seconds it says **Ready to ask**; the data checks run in the background,
   and within a minute or two the strip at the top says it drafted 4 models and 3 joins. Review the
   drafts and accept the ones that passed.

4. **Ask** "Which 5 nations had the most order revenue in 1997?" The answer is labeled **AI-generated**:
   five rows, UNITED STATES first at 1,419,081,800.96. Ask "What was our payroll in 1997?" and ZLens
   says **Not in this data** and runs no query.

5. **Certify it.** On the first answer, select **Save as saved query**, give it a name and an owner, and
   **Save draft**. Open it under **Saved queries**. In **Compare with the old report**, upload the report
   you trust today; for this sample, save these lines as `old-report.csv`:

   ```csv
   N_NATIONKEY,N_NAME,ORDER_REVENUE
   24,UNITED STATES,1419081800.96
   9,INDONESIA,1414884578.36
   6,FRANCE,1409569148.24
   19,ROMANIA,1408772241.42
   13,JORDAN,1396943500.98
   ```

   ZLens says **Matches: 5 of 5 rows, every value**. It matches the file's columns to the answer's by
   name, ignoring case, spaces and underscores; if the answer's columns are named differently, change
   the file's first line to match. Select **Certify**, then ask the first question again: the answer is
   now **Certified**.

6. **Clean up** when you are done:

   ```sql
   DROP DATABASE ZLENS_SAMPLE;
   ```

## The first open: what to expect

- **Press Launch app.** It opens a small ZLens page inside Snowsight. If ZLens has stopped (it stops
  itself after 60 idle minutes), the page starts it and shows the time so far: a start usually
  takes 2 to 3 minutes, and up to 20 minutes the first time after an install or update. Once
  Snowflake reports ZLens ready, the page shows **Open ZLens** and ZLens's address. It never offers
  the address before then.
- **If Snowsight asks you to select a warehouse** before the page opens, pick `ZLENS_APP_WH` (your
  app's name followed by `_WH`), the app's own warehouse: the page runs on it. Snowflake may ask this
  before it opens a Streamlit page that runs on a warehouse, as this one does, for example when your
  user has no default warehouse. If it then says you are missing a default warehouse, that is about
  your own Snowflake user's settings, not ZLens.
- **The page says when it last checked** ("Checked at 16:38 PST", in your Snowflake session's time
  zone). Once ZLens is ready it checks again every minute for 10 minutes, so a ZLens that stops or
  restarts shows as it is, and a stopped one is started again. Then it stops checking, so its
  warehouse can suspend; **Check again** checks once more.
- **If the page says "Set up ZLens first"**, it names the step that is missing and checks again every
  10 seconds for 10 minutes, so it moves on by itself once you save the user. After that, press
  **Check again**.
- **If the page says "One step is missing: grant ZLens a database"**, ZLens can read none of your
  data yet: run step 2's lines (select them all, then **Run**). The page sees the grant at its next
  check and then names the databases ZLens can read, next to the person it serves.
- **If the page looks greyed out** with a **Start** button at the top, Snowsight has put it to
  sleep: press **Start**, then **Check again**.
- **Reopening the page** from the app can first show Snowsight's cached copy of it for a few
  seconds, with the time of that copy's last check. The live page follows, and faded lines from the
  copy can stay under it for up to a minute.
- **Snowflake asks you to sign in again.** Open ZLens opens ZLens's own address in a new tab, and
  Snowflake signs you in there too. The sign-in page names it `SNOWSERVICES_INGRESS`. This is
  Snowflake's own sign-in. A browser that blocks pop-ups blocks Open ZLens too: copy the address
  from the page instead.
- **Close the launcher tab** once ZLens is open. While it stays open it keeps two warehouses running:
  the page's own (the page names it), on which it checks ZLens again for 10 minutes, and the one
  Snowsight shows at the top of the page, usually your own, on which Snowsight's calls for an open
  page run. Snowflake keeps an open page's warehouses running for about 15 minutes after its last use.
- **Not set up yet, or someone else:** until step 1 is done the page shows the setup steps, and it
  tells anyone but the named user that ZLens serves someone else, before starting anything.
- **The address on its own** (a bookmark, a link shared from Snowsight, or a sign-in that finishes
  after ZLens has stopped itself) does not wait: opened while ZLens is stopped or starting, Snowflake
  shows a plain page that reads `"service is not yet running (serviceStatus=PENDING)"`, and each
  reload asks you to sign in again. Start from **Launch app** instead.
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

ZLens asks first, then reads fast, and does the slow work in the background:

1. **Choose your data.** The first time you open ZLens, it lists the schemas of every database granted
   to it, each with its tables, rows, size and how many tables declare their keys, and two estimates:
   reading the names (seconds to minutes) and the background checks (time and credits). With 100
   tables or fewer in all, every schema is ticked already; otherwise start with one area, under 100
   tables, and add more later. A schema that is not listed needs a grant (step 2); the list shows the
   lines with this app's name filled in.
2. **Read these tables.** ZLens reads names, types, comments and declared keys: no table is scanned.
   The page shows the tables read so far, and **Stop** stops it within seconds. When it is done, ZLens
   is **Ready to ask**: answers are labeled **AI-generated** until you review the drafts.
3. **The data checks, in the background.** Unless you untick **Check the data in the background**,
   ZLens then checks the keys, joins and rules behind the drafted models, smallest tables first, and
   builds the search index. Tables over 10 million rows are checked on a block sample, and the drafts
   say "checked on a sample". Each check has a 60-second limit: a table that runs over is listed, not
   waited for, with **Check this table now**. A strip at the top shows the counts as they go ("Checking
   keys and joins: 312 of 1,240 tables"); when the checks end, it points to the drafts in
   **Modeling**. Nothing is saved until you review them.
4. **Setup page.** **Settings » Database** shows every stage with its counts, the time so far, an
   estimate of the time left and of the warehouse credits, and what could not be checked. **Pause**
   stops the checks; **Resume** picks up where they stopped, asking nothing again that was already
   answered. A restart, ZLens's own idle stop or an upgrade resumes them the same way.
5. **Check faster (optional).** Before reading, you can have the background checks run on a Small or
   Medium size of the app's own warehouse (`<app>_WH`): about the same credits, sooner. It goes back
   to extra-small when the checks end. If Snowflake refuses the resize, the checks run on extra-small
   and the Setup page says why.

The launcher page shows the same status before ZLens opens ("ZLens is ready to ask. Background checks:
25%."). An install that was set up before keeps its models: nothing is read or drafted again on an
upgrade.

**Tables added later.** The grants in step 2 cover the tables and views that exist when you run them.
After you add tables or schemas, run those grant lines again for them, then in ZLens open
**Settings » Database**, tick them and press **Read these tables**.

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
- **Ask checks itself.** When ZLens starts, it asks Cortex for one word. If that fails, Ask, Settings and
  the launcher say "Ask is not ready" with the one line an `ACCOUNTADMIN` runs: the `CORTEX_USER` grant with
  your app's name, or the account's cross-region setting. While Ask is not ready, ZLens checks again every
  few minutes for an hour; **Check again** over Ask checks at once. Where Snowflake keeps the Cortex REST API
  off for the account, a working `AI_COMPLETE` counts as ready: nothing to do.
- **When Claude Sonnet 5.5 is not offered to your account**, Ask uses the next Claude model Cortex offers
  you (`claude-opus-5-5`, then `claude-sonnet-4-6`, then `claude-sonnet-4-5`), and **Settings » AI provider**
  says "Ask uses" that model. A model you name there is never replaced.
- **When Ask stops waiting** (its time limit, or you press Stop), ZLens cancels the Cortex query still
  running on the app's warehouse, so the warehouse stops too.

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

The launcher page (**Launch app**) uses three short calls instead, so it can show progress: the
first reads ZLens's state, its address, the person it serves and whether Ask is ready, and starts nothing; the second
lists, by name only, the databases ZLens can read (at most 5), so the page can say when none is
granted yet; the third starts a stopped ZLens and returns at once. Any user of the app may call them:

```sql
CALL ZLENS_APP.app_public.launcher_status();
CALL ZLENS_APP.app_public.launcher_data();
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
- its warehouse: extra-small, and it suspends after 60 seconds with no queries. The launcher page
  runs on it too: an open launcher keeps that warehouse running while it checks (up to 10 minutes
  once ZLens is ready) and for about 15 minutes after that. Snowsight's own calls for the open page
  run on the warehouse shown at the top of the page, usually your own, for as long, so close the
  launcher tab once ZLens is open;
- Cortex: the questions asked, and search by meaning;
- storage: the app's 10Gi block volume, the daily snapshots ZLens keeps of it (the newest 7), and
  any backups you copy to your own stage, all billed as Snowflake storage.

An open ZLens tab does not keep it running: ZLens stops after 60 minutes with no one using it.

## Privileges

The app asks for three account privileges, each shown on its **Permissions** tab: `BIND SERVICE
ENDPOINT` (its own address), `CREATE COMPUTE POOL` (one small pool) and `CREATE WAREHOUSE` (its own
extra-small warehouse), plus the `SNOWFLAKE.CORTEX_USER` database role for Claude. It creates no
listings, shares or external access integrations.

When you press **Get**, Snowflake's dialog also lists, under **Future upgrades**, privileges a later
version could be granted without asking again: `EXECUTE TASK`, `EXECUTE MANAGED TASK`,
`CREATE DATABASE`, `CREATE EXTERNAL ACCESS INTEGRATION`, `CREATE SECURITY INTEGRATION`,
`CREATE SHARE` and `CREATE LISTING`. Snowflake shows that list for every app that asks for its
privileges this way (manifest version 2, automatic grants), minus what the app already asks for.
ZLens asks for none of them, and we do not plan to: it reads only what you grant it, and writes only
inside its own app and to a backup stage you name. A patch cannot add one.

A Snowflake feature policy can stop the app from creating databases and tasks, two of the objects
in that list. It does not cover shares, listings or integrations. ZLens creates neither, so it
works the same with this policy attached. Run as ACCOUNTADMIN, with a database and schema of yours
to hold the policy:

```sql
CREATE FEATURE POLICY MY_DB.MY_SCHEMA.ZLENS_NO_NEW_OBJECTS
  BLOCKED_OBJECT_TYPES_FOR_CREATION = (DATABASES, TASKS);
ALTER APPLICATION ZLENS_APP SET FEATURE POLICY MY_DB.MY_SCHEMA.ZLENS_NO_NEW_OBJECTS;
```

Snowflake's documentation on feature policies for Native Apps has the details.

Its one Streamlit page, the launcher that **Launch app** opens, runs on that same warehouse and
calls only the app's own procedures `app_public.launcher_status()`, `app_public.launcher_data()` and
`app_public.launcher_start()`, and reads the app's name, the time, the name of the warehouse it runs
on and the names of the databases granted to the app; it reads none of your data.

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
