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
# SNOWFLAKE_HOST): deploy/snowflake-app/snowflake-entrypoint.mjs prepares the
# project and starts ZLens (the app's own image has no shell, so that start-up
# is plain Node; this image hands the same path to it).
snowflake_token_file="${ZLENS_SNOWFLAKE_TOKEN_FILE:-/snowflake/session/token}"

is_snowflake_app() {
  [ "${ZLENS_SNOWFLAKE_APP:-}" = "1" ] && return 0
  [ -n "${SNOWFLAKE_HOST:-}" ] && [ -f "$snowflake_token_file" ]
}

if [ "${1:-}" = "zlens" ] || [ "${1:-}" = "dql" ]; then
  if is_snowflake_app; then
    exec node /opt/zlens/snowflake-entrypoint.mjs "$@"
  else
    case "${2:-}" in
      notebook|slack|compile|app|agent|verify|schedule|mcp|lineage)
        maybe_use_demo_project
        ;;
    esac
  fi
fi

exec "$@"
