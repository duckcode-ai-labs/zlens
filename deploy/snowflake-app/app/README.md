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

-- 3. Start it for the one Snowflake user who will use it, and let that user open it.
CALL ZLENS_APP.app_public.start_app('THEIR_SNOWFLAKE_USER', 'MY_WH', 'MY_DB', 'MY_SCHEMA');
GRANT APPLICATION ROLE ZLENS_APP.app_user TO ROLE THEIR_ROLE;

-- 4. Its address (ready a few minutes after starting).
CALL ZLENS_APP.app_public.app_url();
```

Stop it when not in use (its projects are kept): `CALL ZLENS_APP.app_public.stop_app();`

Anyone but the named user who opens it is told the app is set up for one person. AI is Claude through
Snowflake Cortex, which your account must allow.
