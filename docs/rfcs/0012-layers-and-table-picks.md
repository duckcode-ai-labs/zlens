# RFC 0012: Layers, row identity and one table per business thing

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 (with Claude) |
| **Status** | Accepted by the owner on 2026-11-04, as part of the design "ZLens drafts the whole business model" (decisions M1–M10); P1 implemented |
| **Created** | 2026-11-04 |
| **Targets** | The next ZLens release |
| **Discussion** | — |
| **Implementation** | P1: layers, row identity, table picks, layer folders never Domains. P2: joins drafted from row identity; dbt projects drafted from the warehouse. P3 and P4: names, descriptions and concepts, and rules measured on the data. P5: the review screen and `zlens model draft`. After P6: Ask shows the whole model (F1), and two more measured facts (F2) |
| **Supersedes** | — |

## Summary

`zlens model discover --validate` gives every table a layer, finds what one
row is from the data, groups the tables that hold the same rows, and proposes
one table per group. Every other table in a group gets a drafted
`use_instead`, with a reason a person can check. Ask answers from the picked
table until a person confirms or rejects the pick. Layer folders and layer
schema names never become Domains.

This is the first piece (P1) of the design "ZLens drafts the whole business
model". Later pieces cover joins on several columns (P2), names and concepts
(P3), measured rules (P4) and a review screen (P5).

## Motivation

A dbt project usually holds one business thing several times: a raw table, a
staging view that renames it, a history snapshot, a modeled table, and
sometimes an older or narrower modeled table beside the current one.

On the NBA benchmark project, the plain setup read a legacy table on 8 of 40
questions. Its four tables of "a player's season" look alike, and one of them
covers 2003–2022 where the other three cover 2009–2019. A business model built
by hand marked the three narrower ones deprecated, and that removed every
wrong-layer answer (34 → 38 of 40).

ZLens drafted one entity per table and could not tell them apart. On main
before this RFC it picked 0 of the 8 tables right and flagged 0 of the 7
legacy ones, and it knew the row identity of 1 table in 15.

## Detailed design

Everything is measured with counting queries: `COUNT`, `COUNT(DISTINCT …)`,
the number of distinct combinations (`GROUP BY` in a subquery), and `MIN`/`MAX`
of a period column. A season, a year or a date range is the only value read,
and the design's privacy decision (M7) allows ranges. Nothing is certified and
nothing is removed: every outcome is a draft (M2, M3).

### Layer

Strongest evidence first:

1. dbt's resource type: a source or seed is `raw`, a snapshot is `snapshot`;
2. dbt's snapshot columns (`dbt_valid_from` and `dbt_valid_to`): `snapshot`;
3. the dbt folder (`staging/`, `stg/`, `src/`, `intermediate/`, `marts/`,
   `dim/`, `fct/`, `snapshots/`, `seeds/` …);
4. the name prefix (`raw_`, `stg_`, `src_`, `base_`, `int_`, `dim_`, `fct_`,
   `scd_` …);
5. the schema (`raw`, `landing`, `staging`, `intermediate`, `marts`,
   `analytics` …);
6. a view that only renames, casts or filters one raw table is `staging`.

A table nothing marks as earlier is `final`. The dbt facts come from
`target/manifest.json` when the project has one.

### Row identity

Row identity is the fewest columns, from one to three, that are never null and
unique.

- Declared keys and dbt `unique` or `unique_combination_of_columns` tests are
  tried first.
- Then the search tries key-like columns (`id`, `*_id`, `*_key`, `*_code`,
  `*_number` …) and period columns (`season`, `year`, a `*_date`, a `DATE`).
  - Smaller sets come first.
  - Within a size, the order is:
    1. sets of columns that other tables also carry;
    2. keys before periods;
    3. the coarsest combination.
  - So it finds (player_id, season), not (career_season_number, player_id),
    and team_id, not opponent_team_id.
- A short text label (a team name) is tried only when nothing else identifies
  a row.
- When no set is unique, the smallest set with at most 0.5% repeated rows is
  kept, with its count of repeats ("29 rows repeat on games_game_id").
- A history snapshot's identity is read on its current rows
  (`dbt_valid_to IS NULL`).

A unique identity becomes the drafted grain. A near one does not, and its
repeats are reported.

### Look-alike groups

Two tables are grouped when either of these holds:

- one is a view that only renames, casts or filters the other (common table
  expressions are followed);
- they have the same row identity after their column names are made
  comparable:
  - a prefix that names a table is dropped (`details_game_id` →
    `game_id`), but a role is kept (`home_team_id`, `opponent_team_id`);
  - `season_id` is read as `season` where other tables say `season`;
  - a bare `id` is read as the table's own (`raw_customers.id` →
    `customer_id`).

An identity made only of period columns does not group tables: two daily
tables are not the same thing because both are daily.

### The pick, and the reason for every other table

Members are ordered by these, in turn:

1. not a snapshot;
2. period coverage;
3. fewer repeated rows;
4. a later layer;
5. built from the other (view SQL or dbt `depends_on`);
6. more rows;
7. more dbt tests and exposures.

The first is the pick. Another member gets `use_instead` only for a measured
reason:

- it is a history table;
- it covers a shorter period ("covers season 2009–2019; local_player_season_facts
  covers season 2003–2022"; the pick's range contains it and has at least 10%
  more distinct periods);
- its rows repeat where the pick's do not;
- it is an earlier layer;
- the pick is built from it.

The last three apply only when the pick holds at least 95% as many rows.

Fewer rows alone is never a reason. A table of active customers beside all
customers is not a worse copy, and tables nothing tells apart are both kept.

One rule crosses groups. A kept table can point at a wider table when all
three of these hold:

- the wider table carries the narrow table's identity;
- the wider table carries at least 80% of the narrow table's other columns;
- the wider table covers a longer period.

On NBA, a 2009–2019 roster of (player, team, season) points at player game
lines for 2003–2022.

### Joins drafted from row identity (P2)

A join is a table that carries another table's row identity. Every kept table
(not a look-alike) is checked against every kept table whose identity holds a
key and repeats on at most 0.5% of its rows. For each identity column, the
referencing table's matching column is one of these:

- **the same name, once made comparable:**
  - `game_id` for `game_id`;
  - `details_game_id` for `game_id`;
  - `season` for a season table's `season_id`;
- **a role:** a prefix that names no table, such as `opponent_team_id` or
  `home_team_id` for `team_id`.

Rules for what is drafted:

- **One role per join.**
- **A role inside a key of several columns is drafted only on the table
  itself:** the opponent's line of the same game. Elsewhere it is a second way
  to rows the same names already reach.
- **A table's own identity on itself is no join.**

Each candidate is checked with the statement the Modeling page's Validate
runs.

- **Drafted:** a candidate where at most 5% of the referencing rows with a key
  find no row, and the misses are not one placeholder value. The proposed
  cardinality and fanout come from the same statement.
- **The evidence:** it says what the target is one row per, and how many
  referencing rows found their key ("668,338 of 668,339 local_player_game_facts
  rows find their game_id, team_id there").
- **An existing join:** a candidate already drafted from a name gains this
  evidence. If it was never checked, it also takes the check's result.

A drafted join that touches a look-alike is left out and listed. The pick's
own joins are drafted instead.

On DuckDB and SQLite every view is read, including the existing name and key
checks. Elsewhere, a view that joins or aggregates waits for a person, as
before.

### dbt projects read the warehouse (P2, decision M5)

dbt alone drafts only the joins its `relationships` tests hold. On NBA that is
none. In a dbt-first project, `zlens model discover --validate` does this:

1. **Reads the warehouse.** The databases and schemas the dbt nodes live in are
   read with the metadata statements `zlens sync warehouse` runs. Nothing is
   written.
2. **Keys each relation by its dbt node.** That covers models, snapshots, seeds
   and sources; ephemeral models are not in the warehouse. A relation no dbt
   node owns is left out.
3. **Adds what dbt knows.**
   - A model's compiled SQL is its lineage.
   - Its `relationships` tests are declared keys.
   - Its `unique` tests are tried first for row identity.
4. **Picks Domains** from dbt's groups, meta, tags or business folders, else one
   for the project.
5. **Drafts and checks** the same way as for a warehouse-first project.
6. **Binds entities with `dbt_model:`.**

Without `--validate`, dbt discovery proposes Domains only, as before.

### Views on other warehouses (decision M4)

- **DuckDB and SQLite:** every view is read.
- **Elsewhere:** a view that joins or aggregates is read only with
  `--read-views`. It can take minutes to compute, and decision M4 keeps it off
  unless asked.

The estimate-first budget that decision M4 names is not built yet. The flag is
the opt-in until it is.

### Names, descriptions and concepts (P3)

- **Names.** The picked table of a group of look-alikes takes the plain name, without:
  - layer prefixes (`stg_`, `src_`, `dim_`, `fct_`, `int_` …);
  - a leading word three or more tables share that names no row identity (`local_` on NBA);
  - layer suffixes (`_facts`, `_cleansed`, `_final` …).

  So `local_player_game_facts` is `player_game`, "Player game". A look-alike holding that name gives it up and is
  named after its table. Entities already in the model keep their ids, and the drafted joins are renamed with them
  (`player_game_to_team_game`).
- **Descriptions.** Each drafted entity's description comes from what was measured, after any warehouse comment:
  - what one row is, with its repeats;
  - how many rows;
  - the season or date range it covers;
  - for a pick, the look-alikes to answer from it rather than.

  For example: "One row per game_id, player_id: 668,339 rows; season 2003–2022; answer from this table rather
  than src_games_details, int_player_stats."
- **Concepts.** A key that two or more picked tables carry in their row identity, with no picked table of one row
  per key, is a concept. On NBA that is Player (`player_id` in player season and player game, and no players
  table). It binds the pick with the fewest rows as canonical and the rest as conformed.

The words come from templates over the measured facts, not from a model. Decision M1 allows AI for words. The
templates keep every number exact and cost nothing, and the earlier NBA test found AI table descriptions added
nothing to answers (34 → 33 of 40).

### Rules measured on the data (P4)

Rules are measured on the picked tables only: a look-alike's traps are why it was not picked. Each kind is one or
two counting statements:

| Rule | Measured | NBA |
|---|---|---|
| A true/false column whose smaller side is 1% to 35% of the rows | the true and false counts | 109,669 of 668,339 player-game rows have `participated = false` |
| A fixed 2 to 4 rows for every value of one identity column | the minimum and maximum rows per value, and a flag true on exactly one | 2 team-game rows per `game_id`; `is_home = true` picks one |
| A picked table whose identity repeats | rows and distinct keys | 29 games repeat in `src_games` |
| A key whose values all have one length and whose first character takes 2 to 6 values | rows per first character | `game_id`'s first digit: 1, 2, 4, 5 |
| A whole-number season or year whose dates run into the next year (or from the previous one) | the first and last date per period | season 2012 runs from 2012-10-06 to 2013-06-20 |
| Periods holding under 90% of a typical period's rows | rows per period | 2011 holds 83%, 2022 holds 43% (through 2022-12-22) |

- **Rules about a column:** measured once per column name, on the picked table with the most rows.
- **What a rule holds.** It is written as `status: draft`, with the entities it is about and its evidence:
  - the query;
  - what it returned;
  - when.

  The sentence is a template, so each number in it is a number the query returned.
- **What leaves the warehouse:**
  - counts;
  - period ranges;
  - a flag's true or false;
  - the first character of a code column, only where three or more rows share it (decision M7 and the #244
    rule).
- **Rules and concepts already in the model are not drafted again.** Ask leaves out a rule a person marked
  `status: deprecated`.

On NBA, P4 finds five of the hand model's six rules: the participation flag, the two team rows per game, the
repeated games, the game type digit and the season start year. It also finds the short and partial seasons. It
does not find that team attributes are a 2019 snapshot, which no count shows.

### Review (P5)

**The Modeling page.** A drafted model opens in the review drawer, grouped:

1. the tables to answer from, each with its measured description;
2. the look-alikes Ask will skip, each with its reason;
3. the joins, each marked passed, needs a look (with the warehouse's words) or not checked;
4. the rules measured on the data, each with the query that measured it, one click away;
5. the concepts;
6. any other change (a new Domain or area), in the drawer's usual words.

**Accept all that passed** saves every change except the joins whose check did not pass, together, in one step. A
person can still tick and untick single changes and save those. Joins are certified one at a time from the map
once saved (decision M3: nothing is certified automatically). The grouping is read from the drafted changes
themselves, so a draft kept for later reviews the same way.

**dbt-first projects.** They draft from the page too: "Draft the model", and a "Draft the whole model" card on an
empty map. The proposal route runs the dbt draft (decision M5).

**The CLI.** `zlens model draft [path]` prints the same groups. `--apply` writes all of it as drafts, and
`--apply --passed-only` leaves out the joins that need a look.

### After P6: what the measurement asked for

P6 measured the draft on 40 fresh, blind NBA questions: 21 right in substance, against 7 for plain dbt and 27 for the hand-built model. Two causes stood out.

**F1. Ask shows the whole model.**
- **The cause:** in a dbt project, Ask chose a few tables by search, and the drafted model's right table reached the SQL writer on only 23 of 40 questions. When it did, the answer was right on 19 of them.
- **The change:** when a project has a business model of up to 30 tables to answer from, Ask shows the SQL writer every one of them, the chosen tables first, and the step reads "Showed the whole model".
  - The tables to answer from are the ones its entities bind, less those marked `status: deprecated` and the look-alikes a drafted pick sets aside.
  - A larger model chooses as before.

**F2. Two more facts measured.** Both cover where Ask read the right table but the wrong rows.
- **A summary built from every row of a detail table:** a measure of a picked summary (`total_points`) sums to exactly a detail table's (`points`), and to more than its rows of one code. Then the rule says so, and how to get one code: "local_player_season_facts adds up every row of local_player_game_facts, every first character of game_id included … LIKE '2%' gives 1,769,070."
  - It is measured for each summary against the smallest picked detail table that matches. A measure prefix (`total_`) and a table word (`team_`) are set aside when matching names.
  - Five regular-season questions were answered from season totals that include the playoffs.
- **Code values that fall in the next calendar year:** the season rule now adds the codes whose rows all fall in the calendar year after their season. "Rows whose game_id starts with 4 … for those rows, calendar year Y is season Y − 1." That is "the 2016 playoffs" (season 2015), which every arm missed.

Ask now shows up to 12 model rules of up to 800 characters each (was 8 and 500): a drafted NBA model holds 9.

### Manifest

An entity gains an optional field:

```yaml
entities:
  - id: int_season_stat
    relation: nba_analysis.TRANSFORMED.int_season_stats
    status: draft
    use_instead:
      entity: local_player_season_fact
      reason: covers season 2009–2019; local_player_season_facts covers season 2003–2022
```

- It compiles to `ManifestModelEntity.useInstead`, with the entity qualified in
  its Domain.
- A `use_instead` that names no entity is a warning.
- A project that writes none builds the same manifest as before.

`zlens model apply-discovery` writes the field. Applying a chosen entity also
brings the entity it points at.

### Ask

A table whose entity carries `use_instead` is swapped for the table it points
at, following up to three steps. The step says so: "used as the drafted table
pick: X instead of Y (reason)".

A table the question names is kept, labelled "the drafted model prefers X
(reason)", and the reading card says the same. A confirmed pick is
`status: deprecated`, which Ask already leaves out.

### Domains (decision M6)

- **dbt discovery:** a folder named for a layer is never a Domain. Nor is a
  folder whose models carry its name as a prefix (`local/local_*`).
- **No business evidence at all** (no `meta`, group, tag or business folder):
  the project is one Domain, named after it.
- **Warehouse discovery:** layer schema names (`transformed`, `curated`,
  `cleansed`, `refined` …) join the technical schemas, which map into the one
  Domain named after the database.

## Backward compatibility

- No existing field changes.
- `use_instead` is new and optional. Older ZLens versions ignore it, as they
  ignore any unknown entity key.
- Discovery without `--validate` drafts exactly as before.
- With `--validate`, entities also gain a grain from their found identity, and
  table picks.
- In dbt discovery, models that only sat in layer folders are now proposed as
  one project Domain instead of one Domain per folder. Existing Domain Packages
  are kept unchanged.

## Measured on the NBA benchmark project

These numbers come from warehouse-first discovery on a copy of the project,
scored against the hand-built model with `nba/structure_score.py` in the
benchmark repository.

| | main before P1 | P1 |
|---|---|---|
| Tables picked right, of 8 | 0 | 8 |
| Legacy tables flagged, of 7 | 0 | 7 (6 by picks, 1 left out as a staging copy) |
| Row identities right, of 15 | 1 | 14 |
| Joins found, of 17 | 0 | 17 (P2) |
| Joins drafted the hand model does not have | 25 | 5 (P2) |

The whole validated discovery reads 26 relations in about a second on DuckDB.

The 5 joins the hand model does not have are real references:
- player game line → team season;
- player game line → game;
- the 2016 player bio table → team, season and team season.

The stop rule (at least 12 of 17 joins and 6 of 8 picks after P2) passes.

The same draft from the dbt project (dbt-first, `--validate`) scores the same:
8 of 8 picks, 7 of 7 legacy tables, 14 of 15 identities and 17 of 17 joins.
Applied, it compiles to 19 entities and 22 joins bound with `dbt_model:`.
Running discovery again proposes nothing new.

## Alternatives considered

- **Furthest downstream wins.** That picks `fct_player_journey`, the 2009–2019
  table that caused the wrong answers. Lineage is only a tiebreak.
- **Group by column-name overlap.** Layers rename columns (`fgm` →
  `field_goals_made`), so the NBA look-alikes share under a quarter of their
  names. Row identity holds up where names do not.
- **An AI agent that models the project.** That is the alternative in decision
  M1, if the stop rule after P2 fails. Rules plus data checks can be repeated
  and tested, cost little, and every outcome cites a measurement.

## Unresolved questions

- Views that join or aggregate are read on other warehouses only with
  `--read-views`. The estimate-first budget is still to build.
- On a warehouse with no dbt manifest, lineage is known only for views. A table
  built from another table is grouped by its identity alone.
- Entity names still come from table names, so a staging copy can take the
  plain name (`src_players` → `player`). P3 names entities from what a row is.
- The thresholds (0.5% repeats, 95% of rows, 10% more periods, 80% of columns)
  are set from one project. The blind second project in P6 tests them.

## Adoption signal

- The structure score on NBA after P2: at least 6 of 8 table picks (the stop
  rule).
- The second, unseen project: answers drafted with the model beat the plain
  setup.
- How often reviewers keep a drafted pick, and how often they reject one.
