#!/bin/sh
set -eu

log() {
  printf '[zlens-docker] %s\n' "$*"
}

# ZLENS_* first, then the old DQL_* names.
workspace="${ZLENS_PROJECT_ROOT:-${DQL_PROJECT_ROOT:-${ZLENS_WORKSPACE:-${DQL_WORKSPACE:-/workspace}}}}"
demo_root="${ZLENS_DEMO_ROOT:-${DQL_DEMO_ROOT:-$workspace/.dql/docker-starter/dql-starter}}"
template_root="/opt/dql/templates/starter"

is_dql_source_repo() {
  [ -f "$workspace/package.json" ] \
    && [ -f "$workspace/pnpm-workspace.yaml" ] \
    && grep -q '"name": "dql"' "$workspace/package.json"
}

ensure_demo_project() {
  if [ -f "$demo_root/dql.config.json" ]; then
    return 0
  fi

  if [ ! -d "$template_root" ]; then
    log "Bundled starter template not found at $template_root."
    log "Run from a folder with dql.config.json, or rebuild the image."
    exit 1
  fi

  log "No ZLens project found at $workspace."
  log "Creating a starter project at $demo_root."
  log "Tip: to try ZLens on a sample dbt project, clone"
  log "  https://github.com/duckcode-ai/jaffle-shop-duckdb"
  log "and run docker compose from inside it."
  mkdir -p "$demo_root"
  cp -R "$template_root/." "$demo_root/"
  # Resolve scaffold placeholders the same way create-zlens-app would.
  find "$demo_root" -type f -exec sed -i \
    -e 's/{{PROJECT_NAME}}/dql-starter/g' \
    -e 's/{{DBT_DETECTED}}/false/g' \
    -e 's|{{DBT_PROJECT_DIR}}|../my-dbt-project|g' \
    -e "s/{{YEAR}}/$(date +%Y)/g" \
    {} +
}

maybe_use_demo_project() {
  if [ -f "$workspace/dql.config.json" ]; then
    cd "$workspace"
    return 0
  fi

  if is_dql_source_repo; then
    ensure_demo_project
    cd "$demo_root"
    log "Using starter project: $demo_root"
    return 0
  fi

  cd "$workspace"
}

# ── ZLens inside Snowflake ───────────────────────────────────────────────────
# ZLENS_SNOWFLAKE_APP=1, or running in Snowpark Container Services (Snowflake
# writes the service's sign-in token to /snowflake/session/token and sets
# SNOWFLAKE_HOST): the project lives on the mounted volume, is created on the
# first start with one Snowflake connection, and the container reaches nothing
# on the internet. Each default below can be overridden by setting it.
snowflake_token_file="${ZLENS_SNOWFLAKE_TOKEN_FILE:-/snowflake/session/token}"

is_snowflake_app() {
  [ "${ZLENS_SNOWFLAKE_APP:-}" = "1" ] && return 0
  [ -n "${SNOWFLAKE_HOST:-}" ] && [ -f "$snowflake_token_file" ]
}

# The connection, written once into dql.config.json. Account and host stay
# ${...} references, read from the environment at run time, so the project on
# the volume names no account. Inside Snowflake it signs in with the service's
# token file; elsewhere (a local test) with a key pair.
write_snowflake_connection() {
  ZLENS_SF_TOKEN_FILE="$snowflake_token_file" node -e '
    const fs = require("fs");
    const env = process.env;
    const path = "dql.config.json";
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const pick = (name) => env["ZLENS_SNOWFLAKE_" + name] || env["SNOWFLAKE_" + name] || undefined;
    const connection = { driver: "snowflake", account: "${SNOWFLAKE_ACCOUNT}" };
    if (env.SNOWFLAKE_HOST) connection.host = "${SNOWFLAKE_HOST}";
    for (const [key, name] of [["warehouse", "WAREHOUSE"], ["database", "DATABASE"], ["schema", "SCHEMA"], ["role", "ROLE"]]) {
      const value = pick(name);
      if (value) connection[key] = value;
    }
    if (fs.existsSync(env.ZLENS_SF_TOKEN_FILE)) {
      Object.assign(connection, { authMethod: "oauth", tokenFilePath: env.ZLENS_SF_TOKEN_FILE });
    } else if (env.ZLENS_SNOWFLAKE_PRIVATE_KEY_PATH) {
      Object.assign(connection, { authMethod: "key_pair", username: env.ZLENS_SNOWFLAKE_USER || "", privateKeyPath: env.ZLENS_SNOWFLAKE_PRIVATE_KEY_PATH });
    } else {
      console.error("[zlens-docker] No Snowflake sign-in: no token file at " + env.ZLENS_SF_TOKEN_FILE + " and no ZLENS_SNOWFLAKE_PRIVATE_KEY_PATH.");
      process.exit(1);
    }
    config.connections = { snowflake: connection };
    config.defaultConnectionName = "snowflake";
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  '
}

prepare_snowflake_app() {
  export ZLENS_NO_EGRESS="${ZLENS_NO_EGRESS:-1}"
  export ZLENS_LOCK_CONNECTIONS="${ZLENS_LOCK_CONNECTIONS:-1}"
  # No model unless the app package chooses one: ZLENS_MODEL_PROVIDERS=cortex
  # gives it Claude through Snowflake Cortex, signed in with the service's token.
  export ZLENS_MODEL_PROVIDERS="${ZLENS_MODEL_PROVIDERS:-none}"
  # Inside Snowflake its ingress signs people in and names them (Sf-Context-Current-User): ZLens trusts that
  # header there, and only there (the server checks for Snowflake's token file too). ZLENS_SNOWFLAKE_APP_USER,
  # set by the app, names the one person the free app serves.
  if [ -f "$snowflake_token_file" ]; then
    export ZLENS_SNOWFLAKE_INGRESS="${ZLENS_SNOWFLAKE_INGRESS:-1}"
  fi
  mkdir -p "$workspace"
  cd "$workspace"
  if [ ! -f dql.config.json ]; then
    log "First start: creating a warehouse-first project in $workspace."
    zlens init --warehouse-first --yes >/dev/null
    write_snowflake_connection
    log "Project ready with its Snowflake connection."
  fi
}

if [ "${1:-}" = "zlens" ] || [ "${1:-}" = "dql" ]; then
  if is_snowflake_app; then
    prepare_snowflake_app
  else
    case "${2:-}" in
      notebook|slack|compile|app|agent|verify|schedule|mcp|lineage)
        maybe_use_demo_project
        ;;
    esac
  fi
fi

exec "$@"
