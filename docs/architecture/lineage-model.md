# Lineage model

ZLens's lineage graph answers three questions:

1. **What depends on this?** (impact analysis — downstream)
2. **Where did this come from?** (trust chain — upstream)
3. **What's shared across teams?** (cross-domain detection)

## Node types

| Kind | Source |
| --- | --- |
| `source` | dbt source or warehouse table |
| `model` | dbt model |
| `term` | DQL business vocabulary term |
| `block` | DQL block |
| `business_view` | DQL business composition view |
| `notebook` | DQL notebook |
| `dashboard` | DQL dashboard |
| `metric` / `dimension` | Semantic layer object |

## Edge types

| Kind | Meaning |
| --- | --- |
| `reads` | `A` queries from `B` |
| `defines` | A business term defines the meaning of a block or business view |
| `composes` | A block or business view is composed into a higher-level business view |
| `contains` | `A` embeds `B` (e.g. notebook contains block) |
| `materializes_to` | `A` is compiled into `B` (e.g. block → dashboard section) |

## Extraction

SQL-level refs are extracted with `node-sql-parser` (**not regex**), which
correctly handles CTEs, subqueries, lateral joins, `QUALIFY`, and dialect
quirks. Semantic refs (`@metric`, `@block`, `@table`) are extracted from
the DQL AST directly.

Business terms are extracted from `term` declarations and `terms = [...]`
references on blocks and business views. Business composition refs are
extracted from `business_view` declarations:

```text
term -> DQL block -> business_view -> dashboard/App
dbt source -> dbt model -> DQL block -> business_view -> dashboard/App
```

This separates technical data dependencies from business lineage. The technical
lineage answers "what source/model/query produced this block?" Business lineage
answers "what term does this implement, where was it composed, and where is it
consumed by dashboards, Apps, or notebooks?"

## Storage

Lineage is persisted in `.dql/cache/manifest.sqlite` and rebuilt
incrementally — only touched subgraphs are recomputed on a file change.
Warm rebuild on a 4,000-model project is under 2s.

## CLI surface

```bash
zlens lineage summary
zlens lineage --term Customer           # term -> block/view impact
zlens lineage --business-360 Customer   # definition, composition, sources, consumers, gaps
zlens lineage --business "Customer 360" # business composition and technical backing
zlens lineage impact customers          # downstream of `customers`
zlens lineage trust-chain revenue_q4    # upstream of a block
zlens lineage cross-domain              # edges that cross domain boundaries
```

## Business 360

`zlens lineage --business-360 <node>` builds a business-first snapshot from the
same local graph. It works for terms, blocks, business views, dashboards, Apps,
and notebooks.

For a `term`, ZLens first follows outgoing `defines` edges to the blocks and
business views that implement the term. It then traces upstream to source
tables, dbt sources, and dbt models, and traces downstream to dashboards, Apps,
notebooks, nested business views, and blocks.

For a `business_view`, ZLens shows the included blocks or nested views, then
uses those included artifacts to find technical sources and consumption. This
keeps the answer useful even when a dashboard consumes the composed block
directly rather than the view node itself.

The result also includes gaps, such as terms that do not define any artifact,
views with no composition, missing upstream sources, or no downstream
consumers. These are local graph gaps only; org-wide catalog search and
cross-repo lineage stay outside the OSS local lineage surface unless that
metadata is present in the project manifest.

For block-centric views, Business 360 also emits reusable block contracts:
pattern, grain, declared outputs, allowed filters, parameter policies, filter
bindings, source systems, and replacement references. This is how reviewers can
distinguish a reusable parameterized block from static duplicate SQL created
for one set of filter values.

## Column-level lineage

Table-level lineage is fully open-source. **Column-level lineage is a
commercial feature** in the ZLens Enterprise build — see the
[OSS boundaries](https://github.com/duckcode-ai-labs/zlens/blob/main/ROADMAP.md#oss-boundaries).
The manifest output is identical in both builds; column-level is gated at
the surface, not in the graph.
