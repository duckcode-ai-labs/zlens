# Result review: off vs on (November 2026)

**Question.** Should Ask's optional result review be on by default in ZLens for Snowflake?

The review is one more AI call per AI-drafted answer that ran and returned rows. It sees the question, the SQL and the shape of the result (row count, each column's distinct and NULL counts, repeated rows), never a value, and it may send the SQL back for one revision. Today it is opt-in: `agent.resultReview.mode: "on"` in `dql.config.json`, or `ZLENS_ASK_RESULT_REVIEW=1` (see `apps/cli/src/result-review-setting.ts`).

**Rule, set before the runs.** Turn it on by default in the Snowflake app only if it cuts wrong answers and loses no right ones. Otherwise leave it off.

**Recommendation: leave it off.** This PR does not change the default.

- In 25 reviewed answers the review sent no SQL back. All 25 were already right, so it could not cut a wrong answer.
- It added one model call to every AI-drafted answer (2.3 to 3.3 calls) and about 1.4 s (median review call; median answer 10.1 s off, 11.9 s on).
- The misses with the review off were of kinds it can't fix. Three never reached a review: two drafts wrote no SQL, and one question was asked back. The fourth was a follow-up to a refused question. It had rows, but what was wrong was the missing earlier result, which a review of the result's shape can't see.

**The run with the review on is partial.** It stopped after 26 of 76 answers, because the development account's warehouse reached its resource monitor quota. No Snowflake setting was changed. A full run needs the quota raised or reset. The numbers below compare the 26 answers both runs have, and show the full run with the review off.

## Results

### The 26 answers both runs have (round 1, first 26 questions)

The same 26 questions from round 2 of the run with the review off are shown as a repeat, to show how much answers move between runs with nothing changed.

| | Review off, round 1 | Review off, round 2 (repeat) | Review on, round 1 |
|---|---:|---:|---:|
| Right | 25 | 24 | 26 |
| Wrong | 0 | 1 | 0 |
| Refused or no answer | 1 | 1 | 0 |
| Answered Certified (no AI) | 1 | 1 | 1 |
| Model calls | 57 | 56 | 82 |
| Model calls per AI-drafted answer | 2.28 | 2.24 | 3.28 |
| Input tokens | 857,416 | 855,044 | 871,197 |
| Output tokens | 24,395 | 26,644 | 26,304 |
| AI credits (published rate) | 1.175 | 1.186 | 1.203 |
| Median seconds per answer | 10.1 | 11.2 | 11.9 |
| Mean seconds per answer | 10.5 | 10.4 | 11.9 |
| Reviews run / SQL sent back | none | none | 25 / 0 |

**The review call itself:** on average 612 input and 97 output tokens. That is about 0.0013 AI credits, under half a cent, per answer. Its median time was 1.4 s (0.6 to 2.8 s, one at 10.9 s).

The extra right answer with the review on (Part 3 Q4) is not the review's doing. The review accepted that answer unchanged. With the review off, the same question in round 1 wrote no SQL ("the AI could not write SQL that answers it"), so there were no rows to review. Answers move like this between runs: round 2 of the run with the review off differs from its round 1 on three of these 26 questions (four of all 38).

### The full run with the review off (76 answers)

| | Review off |
|---|---:|
| Answers | 76 (38 questions, 2 rounds) |
| Right / wrong / refused | 72 / 1 / 3 |
| Answered Certified (no AI) | 4 |
| Model calls | 163 (2.26 per AI-drafted answer) |
| Tokens per AI-drafted answer | 34,412 in, 1,025 out |
| AI credits | 3.42 |
| Median seconds per answer | 10.1 |

The four misses:

- **Part 3 Q4, round 1: refused.** No SQL was written.
- **Part 3 N5, round 1: asked back.** It is the last question in the long Part 3 chat and should have been answered.
- **Part 1 N3, round 2: refused.** No SQL was written.
- **Part 1 N4, round 2: wrong.** This follow-up came after the refused N3, so it had no prior result to narrow.

None returned rows for the review to check, except N4. Even there the defect was in the context it was given, which a shape-only review can't see.

### Per question

R1 and R2 are the rounds. "Not run" means the run with the review on stopped before that question.

| Question | Off, R1 | Off, R2 | On, R1 | Review verdict | Model calls off / on (R1) | Seconds off / on (R1) |
|---|---|---|---|---|---|---|
| Part 1 K1 | right | right | right | accepted | 3 / 4 | 15.5 / 14.6 |
| Part 1 K2 | right | right | right | accepted | 2 / 3 | 12.9 / 10.2 |
| Part 1 K3 | right | right | right | accepted | 2 / 3 | 9.5 / 9.4 |
| Part 1 K4 | right | right | right | accepted | 2 / 3 | 7.6 / 8.8 |
| Part 1 K5 | right | right | right | accepted | 3 / 4 | 12.2 / 14.2 |
| Part 1 PO-1 | right | right | right | accepted | 2 / 3 | 14.9 / 14.4 |
| Part 1 PO-2 | right | right | right | accepted | 2 / 3 | 13.5 / 16.8 |
| Part 1 G1 | right | right | right | accepted | 2 / 3 | 13.2 / 13.4 |
| Part 1 G2 | right | right | right | accepted | 2 / 3 | 13.5 / 15.9 |
| Part 1 G3 | right | right | right | accepted | 2 / 3 | 7.4 / 9.8 |
| Part 1 G4 | right | right | right | Certified, no AI | 0 / 0 | 2.0 / 2.4 |
| Part 1 N5 | right | right | right | accepted | 3 / 4 | 10.2 / 11.9 |
| Part 1 N3 | right | refused | right | accepted | 2 / 3 | 14.2 / 14.3 |
| Part 1 N4 | right | wrong | right | accepted | 2 / 3 | 9.9 / 14.0 |
| Part 1 G1, first ask | right | right | right | accepted | 2 / 3 | 12.7 / 15.4 |
| Part 1 G1, reworded reply | right | right | right | accepted | 2 / 3 | 15.3 / 20.2 |
| Part 3 Q1 | right | right | right | accepted | 2 / 3 | 7.2 / 6.8 |
| Part 3 Q2 | right | right | right | accepted | 2 / 3 | 6.3 / 8.1 |
| Part 3 Q3 | right | right | right | accepted | 2 / 3 | 7.2 / 7.4 |
| Part 3 Q4 | refused | right | right | accepted | 2 / 3 | 8.8 / 11.3 |
| Part 3 Q5 | right | right | right | accepted | 3 / 4 | 9.2 / 10.3 |
| Part 3 Q6 | right | right | right | accepted | 3 / 4 | 10.4 / 11.8 |
| Part 3 Q7 | right | right | right | accepted | 2 / 3 | 13.8 / 18.1 |
| Part 3 Q8 | right | right | right | accepted | 3 / 4 | 9.0 / 9.3 |
| Part 3 Q9 | right | right | right | accepted | 2 / 3 | 7.3 / 8.0 |
| Part 3 Q10 | right | right | right | accepted | 3 / 4 | 9.9 / 12.1 |
| Part 3 Q11 | right | right | not run | | 3 / | 13.4 / |
| Part 3 Q12 | right | right | not run | | 2 / | 14.4 / |
| Part 3 Q13 | right | right | not run | | 0 / | 2.4 / |
| Part 3 Q14 | right | right | not run | | 3 / | 12.6 / |
| Part 3 Q15 | right | right | not run | | 2 / | 9.2 / |
| Part 3 Q16 (should ask back) | right | right | not run | | 2 / | 9.8 / |
| Part 3 Q17 (should ask back) | right | right | not run | | 1 / | 4.6 / |
| Part 3 N1 | right | right | not run | | 3 / | 10.2 / |
| Part 3 N2 | right | right | not run | | 3 / | 9.3 / |
| Part 3 N3 | right | right | not run | | 2 / | 15.2 / |
| Part 3 N4 | right | right | not run | | 2 / | 13.4 / |
| Part 3 N5 | refused | right | not run | | 1 / | 5.9 / |

## What was run

- **Questions:** the pre-release Ask gate for the Snowflake app. It holds 38 questions an outside tester asked about an NBA dataset, with the answers they checked in SQL. Part 1 asks most questions in a fresh chat; Part 3 asks 22 in one long chat, with follow-ups. Each run asked every question twice (2 rounds, 76 answers). The gate's own checks score the answers.
- **Same build, model and data:** both runs used one build of `main` at the time, Claude Sonnet 5.5 through Snowflake Cortex, and the gate's Snowflake copy of the tester's project. That project has 4 certified saved queries, so 4 of 76 answers need no AI. Each run started from its own identical copy of the project folder, so the first run's history and drafts could not reach the second.
- **Only the setting differed:** `ZLENS_ASK_RESULT_REVIEW=0` for one run, `=1` for the other.
- **One answer at a time,** so the provider usage ledger (`ZLENS_PROVIDER_USAGE_LEDGER`) gives each answer's exact calls and tokens. Seconds are measured end to end, from the request to the answer.
- **Scoring:**
  - **Right:** the gate's check passed.
  - **Refused or no answer:** no answer was given (not run, "Not in this data", asked back when an answer was due), or the answer was missing or ran out of time.
  - **Wrong:** an answer was given with the wrong figures. For the two questions that should be asked back, answering with data counts as wrong.
- **Cost:** AI credits are tokens at Snowflake's published Cortex `AI_COMPLETE` rate for `claude-sonnet-5-5`: 1.20 credits per million input tokens and 6.00 per million output tokens.
  - The whole measurement used 4.86 AI credits: 3.42 with the review off and 1.44 for the partial run with it on. At $3 per credit that is about $14.60.
  - The warehouse ran for about 21 minutes on X-Small, at most about 0.35 credits.

## Not run

- **The rest of the run with the review on (50 answers).** The warehouse could not resume after its resource monitor reached its quota. Finishing it costs about 2.5 more AI credits.
- **The benchmark set.** The repository's runnable Ask benchmark is the insurance set in the separate benchmarks repository. It runs on DuckDB through Claude Code or the Anthropic API, not through Cortex, so it would not be the same model route. Running it within this budget was not possible.

## Caveats

- 26 paired answers and 2 samples per question is a small set. Answers move between runs with nothing changed (see the repeat column).
- This gate's questions are mostly answered right already (72 of 76 with the review off). A set with more wrong-but-plausible answers is where a shape-only review could show a gain. It still cannot see business meaning, which is the day-one risk on a fresh install. Certifying the most-asked questions against the old report covers that risk; the certify-first guide in this PR leads people there.
- The review runs only on the first draft of an AI-drafted answer that returned rows with more than 30 s left. Refusals, questions asked back and certified answers never reach it.
