# ZLens

Governed analytics in your Snowflake account: a semantic layer, certified answers with trust labels,
and Apps. This free app serves **one person**. ZLens runs here, reads only what you grant it, and
keeps its projects on a volume in your account.

## Set up (as ACCOUNTADMIN, or a role that may grant these)

Replace `ZLENS_APP` with this app's name, and the warehouse, database and schema with yours.

```sql
-- 1. Let ZLens run, and open at its own Snowflake address.
GRANT CREATE COMPUTE POOL ON ACCOUNT TO APPLICATION ZLENS_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO APPLICATION ZLENS_APP;

-- 2. What ZLens may read (it reads as the app, only what you grant).
GRANT USAGE ON WAREHOUSE MY_WH TO APPLICATION ZLENS_APP;
GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;
GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;

-- 3. Let ZLens ask Claude through Snowflake Cortex (optional: without it, Ask is off).
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;

-- 4. Start it for the one Snowflake user who will use it, and let that user open it.
CALL ZLENS_APP.app_public.start_app('THEIR_SNOWFLAKE_USER', 'MY_WH', 'MY_DB', 'MY_SCHEMA');
GRANT APPLICATION ROLE ZLENS_APP.app_user TO ROLE THEIR_ROLE;

-- 5. Its address (ready a few minutes after starting).
CALL ZLENS_APP.app_public.app_url();
```

Stop it when not in use (its projects are kept): `CALL ZLENS_APP.app_public.stop_app();`

Anyone but the named user who opens it is told the app is set up for one person.

## What ZLens reaches, sends, stores and logs

- **Endpoints.** One: `ui` (port 3474), ZLens's web page and its API, at the address `app_url()` returns.
  Snowflake signs people in before any request reaches it, and ZLens serves only the user named in
  `start_app`. There is no other way in.
- **Internet.** None. The app asks for no external access integration, and ZLens runs with downloads and
  update checks turned off. Nothing is sent to the app's provider.
- **Your data.** ZLens reads table and column descriptions and runs read-only queries, as the app, on only
  what you granted above. Every query carries a `QUERY_TAG` and shows in your `QUERY_HISTORY`.
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
