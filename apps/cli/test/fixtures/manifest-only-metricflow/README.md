# Manifest-only MetricFlow acceptance fixture

This fixture deliberately contains no DQL domains, models, skills, terms, or
blocks. `workspace/dql.config.json` points to the sibling `dbt/` checkout, so
it covers the ordinary customer starting point: a dbt manifest and MetricFlow
are sufficient for Ask discovery and semantic compilation.

The generated enterprise manifest is sanitized and deterministic. It has more
than 50,000 documented columns, a wide opportunity relation whose useful
fields occur after ordinal 40, and a Salesforce-shaped decoy relation. It is
metadata-only; the local DuckDB dbt project remains small enough to run in a
test environment.

From the repository root, first build the CLI and run the deterministic Ask
semantic-route test:

```sh
pnpm --filter @zlens/cli build
pnpm --filter @zlens/cli exec vitest run src/ask-pipeline-host/manifest-only-enterprise.fixture.test.ts
node apps/cli/test/fixtures/manifest-only-metricflow/run-local-acceptance.mjs
```

`run-local-acceptance.mjs` copies the fixture to a temporary directory, builds
the external dbt project, generates the >50,000-column manifest, runs the
built DQL CLI against it, and invokes local MetricFlow. Its deterministic
oracles cover the photographed shapes: total BCM (`700`), ranked customers,
FY26/Splunk lost opportunities by month, DOD quantity and percentage,
Capital One current versus previous month (`120` vs `100`), and an authored
previous-year MetricFlow offset (`120` vs `80`). It prints cold/warm timings.
The prior-year query necessarily has a one-row `metric_time__month` compiler
support grain; Ask strips only this explicit one-row support column when it
returns the requested scalar comparison.

Set `DQL_METRICFLOW_BIN` if `mf` is not on `PATH`,
`DQL_MANIFEST_ONLY_DBT_BIN` when the matching dbt executable is elsewhere,
and `DQL_MANIFEST_ONLY_CLI` only when the built CLI is elsewhere.

The direct MetricFlow stage requires a MetricFlow environment that contains the
adapter for this fixture (`dbt-metricflow[dbt-duckdb]`). The runner fails
explicitly if that adapter is absent and never installs it. The deterministic
Vitest case still proves the actual Ask → semantic-adapter → scalar execution
route independently. Snowflake physical-name behavior is covered by exact,
target-bound mock tests; this fixture must not be described as an
office-Snowflake execution.
