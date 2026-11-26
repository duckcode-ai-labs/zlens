# Onboarding large test

The first-open onboarding ("pick your data, fast first, details later")
promises, for a scope of 1,000 tables:

| Target | Measured on DuckDB, 1,005 tables |
| --- | --- |
| Ready to ask within 2 minutes | 0.5 to 0.6 s |
| Counts update at least every 3 s while a stage runs | longest gap 0.3 s while reading, 0.9 s while checking; longest wait for an answer 0.7 s (it was 2.9 s while the drafts were written, before they were written in turns) |
| Stop stops the background checks within 5 s | 0.3 to 0.7 s |
| A resume repeats no finished check | 0 statements asked twice (195 kept answers reused) |
| Answers no worse than before | the release gate on Snowflake: 76 of 76, as before (see below) |

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
- the longest wait for an answer from ZLens. A server busy at the very end of
  a stage shows only here, since the stage has finished by the time it
  answers again;
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

## The drafts written in turns (26 November 2026)

On Snowflake the same test showed one 4.1 s wait (results below): writing the
150 drafted tables for review held ZLens for 3 to 4 s, so the counts stood
still and Ask waited. A CPU profile put almost all of it in composing the
review, which parsed the whole warehouse catalog again for each change, twice.

Now:
- the catalog is parsed once for the whole batch, and each change is written
  as previewed, not previewed again;
- the background setup writes its drafts in turns, giving the event loop back
  at least every 200 ms, as a phase of its own with its counts ("Writing the
  drafts for review: 120 of 412 changes").

| DuckDB, 1,005 tables, twice each | Before | After |
| --- | --- | --- |
| Longest wait for an answer while checking | 2.9 s, 2.8 s | 0.7 s, 0.6 s |
| Longest gap between updates while checking | 0.8 s, 0.5 s | 0.9 s, 0.8 s |
| Longest the server did nothing else (CPU profile) | 3.1 s | 0.9 s |
| Resume to done | 13.8 s, 13.4 s | 11.5 s, 11.3 s |

## Results on Snowflake, 26 November 2026

An X-Small warehouse in a sandbox account, the build with all of the
onboarding work.

**The data:** 1,000 copies of the 24 TPC-DS sample tables, 500 to 5,000 rows
each with their own column names and no declared keys, in 10 schemas, plus 8
views over the TPC-H SF100 sample in another database (ORDERS 150 million
rows, LINEITEM 600 million).

| Step | Result |
| --- | --- |
| Discovery with sizes | 14.3 s |
| Ready to ask, 1,008 tables and views | 10.6 s; longest gap between updates 1.8 s |
| Stop after 20 s of checks | 0.9 s |
| A resume repeats no finished check | 0 statements asked twice |
| Background checks to done | 14.5 min: 150 models and 191 joins drafted, each join checked on the data; 858 tables read and checked but not drafted |
| Longest gap while checking | 4.1 s, while the drafts were written (fixed above) |
| Warehouse credits | about 0.27 for the test, 0.04 to make the data |

The two largest views ran into the 60 s limit for each background check, as
designed: views are never sampled. The Setup page showed Snowflake's own
"SQL execution canceled": the driver lost its own deadline when Snowflake
ended the statement before any row. It now says the statement ran over its
deadline, and the Setup page says: "LINEITEM and ORDERS: not checked. A check
took longer than the 60-second limit for background checks, so it was
skipped, and the drafts do not rely on it."

**Answers.** The release gate's questions on Snowflake, with Cortex:
- on a project set up before (its model kept, nothing drafted again on
  upgrade): 76 of 76 in two rounds, against 75 of 76 for the last release;
- on a fresh project with no model, on a database without declared keys: 21
  of 38 at Ready (names only), 35 of 38 after the 49 s of checks.
