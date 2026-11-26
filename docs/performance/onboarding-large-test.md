# Onboarding large test

The first-open onboarding ("pick your data, fast first, details later")
promises, for a scope of 1,000 tables:

| Target | Measured on DuckDB, 1,005 tables |
| --- | --- |
| Ready to ask within 2 minutes | 0.5 to 0.6 s |
| Counts update at least every 3 s while a stage runs | longest gap 0.3 s while reading, 0.5 s while checking (a single 2.9 s pause while the drafts are written) |
| Stop stops the background checks within 5 s | 0.3 to 0.7 s |
| A resume repeats no finished check | 0 statements asked twice (195 kept answers reused) |
| Answers no worse than before | to measure on Snowflake with the release gate |

## The data

- **1,000 small tables** in 10 schemas (`ob_s01` to `ob_s10`, 100 each), each
  with about 20 columns and 500 to 5,000 rows, and no declared keys, like a
  warehouse that declares none.
- **5 large tables** in `large`: 50,000 to 15 million rows. Three are over the
  10-million-row check budget, so they are checked on a block sample.

In all, 42 million rows in 1,005 tables.

## How to run it

Start ZLens on a project whose connection reads the data. For example, start
the notebook on a DuckDB file holding the tables above. Then run:

```bash
node scripts/onboarding-large-test.mjs --url http://127.0.0.1:3474 \
  --project <project dir> --fresh --stop-after 15 \
  --scopes 'big:ob_s01,ob_s02,ob_s03,ob_s04,ob_s05,ob_s06,ob_s07,ob_s08,ob_s09,ob_s10,large'
```

The script needs no credentials: ZLens's own connection does the reading.

What the script does:
1. Lists the schemas with their sizes.
2. Reads the names of the scope given, and times how long until Ready.
3. Lets the background checks run for `--stop-after` seconds, then presses
   Stop.
4. Starts the checks again and follows them to the end.

What it records:
- the longest gap between two updates of the counts;
- how long Stop took;
- how many answers the resume reused;
- how many statements were asked twice. This is read from
  `.dql/local/setup-checks.jsonl`, so it must be 0.

Against the ZLens app for Snowflake, pass the ingress's signed-in user with
`--header`.

## Results, 26 November 2026 (DuckDB, laptop)

**First measurement**, with every checked table drafted for review:
- Ready in 0.5 s.
- The checks themselves were done in about 18 s.
- ZLens then stopped answering for about 140 s while it built the review of
  1,005 drafted models and 1,958 drafted joins. Building the review applies
  each change to the project's YAML in turn, so the cost grows with the square
  of the number of changes.

That broke two targets: counts every 3 s, and Ask while the checks run. The
background setup now follows the design's "Reuse" row and extends the
150-table draft budget of the dbt path to the warehouse path:
- every table chosen is read and checked;
- the drafts hold the 150 most connected business tables, and only the joins
  the checks validated;
- the rest are listed on the Setup page, and Ask reads them all.

**With that change:**

| Step | Result |
| --- | --- |
| Discovery with sizes | under 0.1 s |
| Ready to ask, 1,005 tables | 0.5 s, no table scanned; longest gap between updates 0.3 s |
| Full background checks from nothing kept | 22 s: every key, joins up to the per-run limit of 200, 3 tables on samples, 150 models drafted |
| Longest pause of the server | 2.9 s, while the drafts are written |
| Stop after 8 s of checks | 0.7 s (69 tables, 195 answers kept) |
| Resume to done | 12.8 s: the 195 answers reused, 0 statements asked twice; longest gap between updates 0.5 s |

The Setup page lists two items it did not do:
- "855 more tables were read and checked but not drafted";
- "1,958 joins not checked: the background check validates at most 200 a run".

## Still to measure on Snowflake

- The same scope on an X-Small warehouse, with the same script.
- The release gate's questions, asked at Ready (names only) and again after
  the checks, on a database without declared keys.
- The gate on today's build and on this one, to confirm answers are no worse.
