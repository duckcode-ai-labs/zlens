-- ZLens for Snowflake: the free, one-person app.
CREATE APPLICATION ROLE IF NOT EXISTS app_admin;
CREATE APPLICATION ROLE IF NOT EXISTS app_user;
GRANT APPLICATION ROLE app_user TO APPLICATION ROLE app_admin;

CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;
CREATE OR ALTER VERSIONED SCHEMA app_public;
GRANT USAGE ON SCHEMA app_public TO APPLICATION ROLE app_user;

-- Starts ZLens (or applies new settings, or a new version after an upgrade) for the one Snowflake
-- user it serves, reading the given warehouse, database and schema as the app itself.
CREATE OR REPLACE PROCEDURE app_public.start_app(person VARCHAR, warehouse VARCHAR, database VARCHAR, schema VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
  pool VARCHAR;
  env VARCHAR;
BEGIN
  pool := CURRENT_DATABASE() || '_POOL';
  env := REPLACE(TO_JSON(OBJECT_CONSTRUCT(
    'ZLENS_SNOWFLAKE_APP_USER', UPPER(:person),
    'ZLENS_SNOWFLAKE_WAREHOUSE', :warehouse,
    'ZLENS_SNOWFLAKE_DATABASE', :database,
    'ZLENS_SNOWFLAKE_SCHEMA', :schema,
    'ZLENS_MODEL_PROVIDERS', 'cortex')), '''', '');
  CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool)
    MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = CPU_X64_XS
    AUTO_RESUME = TRUE AUTO_SUSPEND_SECS = 3600;
  BEGIN
    ALTER COMPUTE POOL IDENTIFIER(:pool) RESUME;
  EXCEPTION WHEN OTHER THEN NULL;  -- already running
  END;
  EXECUTE IMMEDIATE 'CREATE SERVICE IF NOT EXISTS core.zlens IN COMPUTE POOL ' || :pool
    || ' FROM SPECIFICATION_TEMPLATE_FILE = ''zlens.yaml'' USING (env => ''' || :env || ''')';
  EXECUTE IMMEDIATE 'ALTER SERVICE core.zlens FROM SPECIFICATION_TEMPLATE_FILE = ''zlens.yaml'' USING (env => ''' || :env || ''')';
  BEGIN
    ALTER SERVICE core.zlens RESUME;
  EXCEPTION WHEN OTHER THEN NULL;  -- already running
  END;
  GRANT SERVICE ROLE core.zlens!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
  RETURN 'ZLens is starting for ' || UPPER(:person) || '. In a few minutes, CALL app_public.app_url() gives its address.';
END;
$$;
GRANT USAGE ON PROCEDURE app_public.start_app(VARCHAR, VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_admin;

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
  RETURN 'ZLens stopped. Its projects are kept; CALL app_public.start_app(...) starts it again.';
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
