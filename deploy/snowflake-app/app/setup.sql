-- ZLens for Snowflake: the free, one-person app, set up in Snowsight. Snowflake grants it a compute
-- pool, its address and a warehouse at install (manifest_version 2); the admin enters the person on
-- the Configurations tab and grants it one database. ZLens starts at install, reads both while it
-- runs, and stops itself after 30 idle minutes (opening it starts it again).
CREATE APPLICATION ROLE IF NOT EXISTS app_admin;
CREATE APPLICATION ROLE IF NOT EXISTS app_user;
GRANT APPLICATION ROLE app_user TO APPLICATION ROLE app_admin;

CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;
CREATE OR ALTER VERSIONED SCHEMA app_public;
GRANT USAGE ON SCHEMA app_public TO APPLICATION ROLE app_user;

-- Who uses ZLens: entered on the app's Configurations tab (or ALTER APPLICATION ... SET CONFIGURATION
-- zlens_user VALUE = '...'). ZLens reads it on every sign-in; until it is set, ZLens shows the steps.
ALTER APPLICATION SET CONFIGURATION DEFINITION zlens_user
  TYPE = STRING
  LABEL = 'Snowflake user who uses ZLens'
  DESCRIPTION = 'The one Snowflake user this free app serves (their user name, for example JSMITH). Anyone else who opens ZLens is refused.'
  APPLICATION_ROLES = (app_admin)
  SENSITIVE = FALSE;

-- Optional: a stage the customer owns where ZLens puts a daily copy of its projects, which outlives
-- an uninstall. The admin creates it, grants it to the app (GRANT READ, WRITE ON STAGE ... TO
-- APPLICATION ...), and names it here.
ALTER APPLICATION SET CONFIGURATION DEFINITION zlens_backup_stage
  TYPE = STRING
  LABEL = 'Stage for ZLens backups (optional)'
  DESCRIPTION = 'A stage you own and granted to this app (GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION <this app>), as DATABASE.SCHEMA.STAGE. ZLens copies its projects there once a day; the copies stay if the app is uninstalled.'
  APPLICATION_ROLES = (app_admin)
  SENSITIVE = FALSE;

-- ZLens's own warehouse, compute pool and service: created at install, moved to the new version at
-- an upgrade (a stopped service stays stopped), and started when resume is TRUE.
CREATE OR REPLACE PROCEDURE core.ensure_zlens(resume BOOLEAN)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
  app VARCHAR;
  pool VARCHAR;
  wh VARCHAR;
  env VARCHAR;
BEGIN
  app := CURRENT_DATABASE();
  pool := app || '_POOL';
  wh := app || '_WH';
  EXECUTE IMMEDIATE 'CREATE WAREHOUSE IF NOT EXISTS ' || :wh
    || ' WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE';
  env := REPLACE(TO_JSON(OBJECT_CONSTRUCT(
    'ZLENS_SNOWFLAKE_WAREHOUSE', :wh,
    'ZLENS_SNOWFLAKE_APP_SETTINGS', '1',
    'ZLENS_SNOWFLAKE_APP_USER_CONFIGURATION', 'ZLENS_USER',
    'ZLENS_SNOWFLAKE_APP_NAME', :app,
    'ZLENS_SNOWFLAKE_SERVICE', :app || '.CORE.ZLENS',
    'ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES', '30',
    'ZLENS_MODEL_PROVIDERS', 'cortex')), '''', '');
  CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool)
    MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = CPU_X64_XS
    AUTO_RESUME = TRUE AUTO_SUSPEND_SECS = 600;
  EXECUTE IMMEDIATE 'CREATE SERVICE IF NOT EXISTS core.zlens IN COMPUTE POOL ' || :pool
    || ' FROM SPECIFICATION_TEMPLATE_FILE = ''zlens.yaml'' USING (env => ''' || :env || ''')';
  EXECUTE IMMEDIATE 'ALTER SERVICE core.zlens FROM SPECIFICATION_TEMPLATE_FILE = ''zlens.yaml'' USING (env => ''' || :env || ''')';
  IF (resume) THEN
    BEGIN
      ALTER COMPUTE POOL IDENTIFIER(:pool) RESUME;
    EXCEPTION WHEN OTHER THEN NULL;  -- already running
    END;
    BEGIN
      ALTER SERVICE core.zlens RESUME;
    EXCEPTION WHEN OTHER THEN NULL;  -- already running
    END;
  END IF;
  GRANT SERVICE ROLE core.zlens!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
  RETURN 'ok';
END;
$$;

CALL core.ensure_zlens(FALSE);

-- Starts ZLens again after stop_app() (opening its address also starts it).
CREATE OR REPLACE PROCEDURE app_public.start_app()
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
BEGIN
  CALL core.ensure_zlens(TRUE);
  RETURN 'ZLens is starting. In a minute or two, CALL app_public.app_url() gives its address.';
END;
$$;
GRANT USAGE ON PROCEDURE app_public.start_app() TO APPLICATION ROLE app_admin;

-- Stops ZLens and its compute pool; projects and history stay on its volume. start_app() resumes.
CREATE OR REPLACE PROCEDURE app_public.stop_app()
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
  pool VARCHAR;
BEGIN
  pool := CURRENT_DATABASE() || '_POOL';
  ALTER SERVICE IF EXISTS core.zlens SUSPEND;
  ALTER COMPUTE POOL IF EXISTS IDENTIFIER(:pool) SUSPEND;
  RETURN 'ZLens stopped. Its projects are kept; opening it, or CALL app_public.start_app(), starts it again.';
END;
$$;
GRANT USAGE ON PROCEDURE app_public.stop_app() TO APPLICATION ROLE app_admin;

-- ZLens's address in the browser (Snowflake signs the person in there).
CREATE OR REPLACE PROCEDURE app_public.app_url()
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
  url VARCHAR DEFAULT 'Not ready yet: try again in a minute.';
  endpoints RESULTSET;
BEGIN
  endpoints := (EXECUTE IMMEDIATE 'SHOW ENDPOINTS IN SERVICE core.zlens');
  LET c CURSOR FOR endpoints;
  FOR endpoint IN c DO
    IF (endpoint."ingress_url" LIKE '%snowflakecomputing.app%') THEN
      url := 'https://' || endpoint."ingress_url";
    END IF;
  END FOR;
  RETURN url;
END;
$$;
GRANT USAGE ON PROCEDURE app_public.app_url() TO APPLICATION ROLE app_user;

-- Backups: ZLens snapshots its volume once a day (keeping 7) as it stops for the day. These list
-- them, take one now, and put one back.
CREATE OR REPLACE PROCEDURE app_public.backups()
RETURNS TABLE (name VARCHAR, state VARCHAR, created_on VARCHAR)
LANGUAGE SQL
AS
$$
DECLARE
  snapshots RESULTSET;
BEGIN
  snapshots := (EXECUTE IMMEDIATE 'SHOW SNAPSHOTS IN SCHEMA core ->> SELECT "name"::VARCHAR AS name, "state"::VARCHAR AS state, TO_VARCHAR("created_on", ''YYYY-MM-DD HH24:MI TZH:TZM'') AS created_on FROM $1 WHERE STARTSWITH("name", ''ZLENS_BACKUP_'') OR STARTSWITH("name", ''SYS_BACKUP'') ORDER BY "created_on" DESC');
  RETURN TABLE(snapshots);
END;
$$;
GRANT USAGE ON PROCEDURE app_public.backups() TO APPLICATION ROLE app_admin;

CREATE OR REPLACE PROCEDURE app_public.back_up_now()
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
  snapshot VARCHAR;
BEGIN
  snapshot := 'ZLENS_BACKUP_' || TO_CHAR(SYSDATE(), 'YYYYMMDD_HH24MISS');
  EXECUTE IMMEDIATE 'CREATE SNAPSHOT core.' || :snapshot || ' FROM SERVICE core.zlens VOLUME "workspace" INSTANCE 0 COMMENT = ''ZLens backup''';
  RETURN 'Backup ' || :snapshot || ' started; it is ready in about a minute (CALL app_public.backups()).';
END;
$$;
GRANT USAGE ON PROCEDURE app_public.back_up_now() TO APPLICATION ROLE app_admin;

-- Puts the projects back as they were in a backup: ZLens stops, its volume is restored, and it
-- starts again in about three minutes. Snowflake keeps the replaced volume for 7 days
-- (SYS_BACKUP_ON_DELETE...), so this can be undone the same way.
CREATE OR REPLACE PROCEDURE app_public.restore_backup(backup VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
  name VARCHAR;
BEGIN
  name := UPPER(TRIM(:backup));
  IF (NOT REGEXP_LIKE(:name, '(ZLENS_BACKUP_[0-9]{8}_[0-9]{6})|(SYS_BACKUP_ON_DELETE[A-Z0-9_]+)')) THEN
    RETURN 'Not a ZLens backup: ' || :backup || '. CALL app_public.backups() lists them.';
  END IF;
  ALTER SERVICE core.zlens SUSPEND;
  EXECUTE IMMEDIATE 'ALTER SERVICE core.zlens RESTORE VOLUME "workspace" INSTANCES 0 FROM SNAPSHOT core.' || :name;
  RETURN 'Restoring ' || :name || ': ZLens starts again in about three minutes.';
END;
$$;
GRANT USAGE ON PROCEDURE app_public.restore_backup(VARCHAR) TO APPLICATION ROLE app_admin;
