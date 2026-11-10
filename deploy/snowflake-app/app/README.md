# ZLens

Governed analytics in your Snowflake account: a semantic layer, certified answers with trust labels,
and Apps. This free app serves **one person**. ZLens runs here, reads only what you grant it, and
keeps its projects on a volume in your account.

## Set up (in Snowsight, as ACCOUNTADMIN or the role that installed the app)

When you get the app, Snowflake gives it what it needs to run: a small compute pool, its own address,
and an extra-small warehouse for its queries. ZLens starts by itself. Then:

1. **Who uses ZLens.** Open **Apps** in Snowsight's left menu, then this app, then its **Configurations**
   tab. Pick a warehouse at the top of the page first (Snowsight needs one to save), then **Review**,
   enter the Snowflake user name of the one person who will use ZLens, and **Save**. (In SQL:
   `ALTER APPLICATION ZLENS_APP SET CONFIGURATION ZLENS_USER VALUE = 'THEIR_USER';`)
2. **What ZLens may read.** Grant the app one database (replace `ZLENS_APP` with the app's name and
   `MY_DB`, `MY_SCHEMA` with yours; repeat the schema lines for more schemas in that database):

   ```sql
   GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;
   GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
   GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
   GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
   ```

3. **Let that person open it.** On the app's page, *Access management*: add their role (the role that
   installed the app can open it already). (In SQL:
   `GRANT APPLICATION ROLE ZLENS_APP.app_user TO ROLE THEIR_ROLE;`)
4. **Ask with Claude** (optional): `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;`
5. **Open it:** *Launch app* on the app's page (it opens a new window), or
   `CALL ZLENS_APP.app_public.app_url();` for its address. It opens straight into the project.

**ZLens sets itself up from your tables.** Once it has the database, ZLens reads every schema in it
the app can see, then drafts the models (entities, their keys and the joins between them) from those
tables. A strip at the top says so while it runs, in a minute or two, then points to the drafts in
**Modeling**: nothing is saved until you review them. To read the tables again later (after new
grants, say): **Settings » Database » Apply and synchronize**.

**Ask with Claude** uses Snowflake Cortex. Where Snowflake refuses the Cortex REST API for the account,
ZLens asks Cortex through SQL (`AI_COMPLETE`) instead; **Settings » AI » Test** says which one answers.

Until steps 1 and 2 are done, whoever opens ZLens sees which of them is still missing. ZLens picks up
changes within a minute, without a restart. Anyone but the named user is told the app is set up for
one person.

**Backups.** ZLens backs up its projects once a day, as it stops for the day, and keeps the last 7
(**Settings » Backups**, or `CALL ZLENS_APP.app_public.backups();`). To put one back:
`CALL ZLENS_APP.app_public.restore_backup('<name>');` (ZLens stops and starts again in about three
minutes; Snowflake keeps the replaced volume for 7 days, so this can be undone the same way). These
backups are inside the app: **uninstalling it removes them**. To keep a copy that outlives the app,
give ZLens a stage of your own and name it on the **Configurations** tab ("Stage for ZLens backups"):

```sql
CREATE STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS;
GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;
GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION ZLENS_APP;
```

ZLens then copies its projects there once a day when something changed (`zlens-<app>-<date>.tar.gz`,
the last 14 kept). A copy is a plain ZLens project: it opens in ZLens on a laptop, and a new install
whose project is empty offers to restore the newest one.

**It stops by itself.** After 30 minutes with no one using it, ZLens stops (its projects are kept), and
opening it again starts it, in a minute or two. To stop it now: `CALL ZLENS_APP.app_public.stop_app();`
To start it without opening it: `CALL ZLENS_APP.app_public.start_app();`

## What ZLens reaches, sends, stores and logs

- **Endpoints.** One: `ui` (port 3474), ZLens's web page and its API, at the address `app_url()` returns.
  Snowflake signs people in before any request reaches it, and ZLens serves only the user named on
  the Configurations tab. There is no other way in.
- **Internet.** None. The app asks for no external access integration, and ZLens runs with downloads and
  update checks turned off. Nothing is sent to the app's provider.
- **Your data.** ZLens reads table and column descriptions and runs read-only queries, as the app, on only
  the database you granted, with its own warehouse. Every query carries a `QUERY_TAG` and shows in your `QUERY_HISTORY`.
- **AI.** Questions go to Claude through Snowflake Cortex, inside Snowflake. A prompt holds the question,
  table and column names, metric definitions, and sometimes rows of a query result. Cortex may process it
  in another Snowflake region if your account allows cross-region inference. The app's provider never
  receives prompts or replies, and trains nothing on them.
- **Stored.** On the app's 10Gi block volume in your account: ZLens's project (connection settings,
  metrics, notebooks, Apps), the questions asked with their answers and SQL, run history, cached
  descriptions of your tables, and backups of the project from before each upgrade. It stays until the app is
  uninstalled (`DROP APPLICATION ... CASCADE`), which deletes it.
- **Logged.** Start-up messages, warnings and errors, to your account's event table if you have one.
  Questions, SQL and query results are not logged.

How every part connects: [ARCHITECTURE.md](https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/ARCHITECTURE.md).
