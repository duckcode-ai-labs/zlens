# Result review: off vs on (November 2026)

**Question.** Should Ask's optional result review be on by default in ZLens for Snowflake?

The review is one more AI call per AI-drafted answer that ran and returned rows. It sees the question, the SQL and the shape of the result (row count, each column's distinct and NULL counts, repeated rows), never a value, and it may send the SQL back for one revision. Today it is opt-in: `agent.resultReview.mode: "on"` in `dql.config.json`, or `ZLENS_ASK_RESULT_REVIEW=1` (see `apps/cli/src/result-review-setting.ts`).

**Rule, set before the runs.** Turn it on by default in the Snowflake app only if it cuts wrong answers and loses no right ones. Otherwise leave it off.

**Verdict: the rule is not met. The review stays off by default.** Both runs are complete: 76 answers each.

- **The review changed no answer.** It ran on 66 answers, accepted all 66 and sent no SQL back.
- **The totals look better with it on, but by chance.** With the review off there were 72 right, 1 wrong and 3 refused. With it on there were 74 right, 0 wrong and 2 refused.
  - Every difference came from the AI drafting the SQL differently from one run to the next, not from the review.
  - Answers move like this with nothing changed. The run with the review off differs between its own two rounds on 4 of 38 questions.
- **It also lost a right answer.** Paired by question and round, the run with the review on lost one right answer (Part 3 Q4, round 2).
  - The draft wrote no SQL, so the review never ran.
  - The rule as written still counts it as a loss.
- **The evidence on wrong answers is weak.** That is what the rule asks about.
  - With the review off there was 1 wrong answer in 76. What made it wrong was missing context, not a result the review could judge.
  - All 66 answers the review saw were right, so this set can't show whether it catches wrong ones.
- **What the runs do show:**
  - **No false alarms:** it sent back none of 66 right answers. The 95% upper bound on that rate is about 4.4%.
  - **Low cost:** one more model call per AI-drafted answer, about 0.0012 AI credits and about 1 s.

## Results

### Totals (76 answers each: 38 questions, 2 rounds)

| | Review off | Review on | Change |
|---|---:|---:|---:|
| Right | 72 | 74 | +2 |
| Wrong | 1 | 0 | -1 |
| Refused or no answer | 3 | 2 | -1 |
| Answered Certified (no AI) | 4 | 4 | 0 |
| Answers that called the model | 72 | 72 | 0 |
| Model calls | 163 | 228 | +65 |
| Model calls per AI-drafted answer | 2.26 | 3.17 | +0.90 |
| Input tokens | 2,477,662 | 2,482,042 | +4,380 |
| Output tokens | 73,784 | 73,827 | +43 |
| AI credits, scored answers (published rate) | 3.42 | 3.42 | +0.005 |
| Median seconds per answer | 10.1 | 10.8 | +0.8 |
| Mean seconds per AI-drafted answer | 10.5 | 11.4 | +0.9 |
| Reviews run / SQL sent back / failed | none | 66 / 0 / 0 | |

**The review call itself:**

- **Size:** on average 621 input and 71 output tokens. That is about 0.0012 AI credits per answer, and 0.08 for all 66 reviews.
- **Time:** median 1.0 s (0.6 to 2.9 s, one at 10.9 s).

Total tokens per answer barely moved (+61 input per AI-drafted answer). The other calls vary more from run to run than the review adds.

**Six AI-drafted answers had no review**, because none of them returned rows:

- four correct questions back (Q16 and Q17, both rounds);
- one question asked back when an answer was due (Part 3 N5, round 1);
- one draft that wrote no SQL (Part 3 Q4, round 2).

### What changed

Four answers changed outcome between the runs (same question, same round). The review accepted every one that reached it, unchanged.

- **Part 1 N3, round 2: refused off, right on.** With the review off, the draft wrote no SQL.
- **Part 1 N4, round 2: wrong off, right on.** This is the follow-up to N3.
  - With the review off, N3 was refused, so N4 had no earlier result to narrow.
  - With the review on, N3 was answered, so N4 was too.
- **Part 3 Q4, round 1: refused off, right on.** With the review off, the draft wrote no SQL.
- **Part 3 Q4, round 2: right off, refused on.** With the review on, the draft wrote no SQL, so the review never ran.

Part 3 N5, round 1 was asked back in both runs. It is the last question of the long Part 3 chat with the review off, and the twelfth in the resumed chat with it on (see below).

### Per question

R1 and R2 are the rounds. Model calls and seconds are shown as off / on, round 1 then round 2.

| Question | Off, R1 | Off, R2 | On, R1 | On, R2 | Review verdict (on) | Model calls off / on (R1; R2) | Seconds off / on (R1; R2) |
|---|---|---|---|---|---|---|---|
| Part 1 K1 | right | right | right | right | accepted | 3 / 4; 2 / 3 | 15.5 / 14.6; 8.8 / 12.7 |
| Part 1 K2 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 12.9 / 10.2; 13.1 / 12.3 |
| Part 1 K3 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 9.5 / 9.4; 12.5 / 10.6 |
| Part 1 K4 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 7.6 / 8.8; 7.4 / 7.7 |
| Part 1 K5 | right | right | right | right | accepted | 3 / 4; 2 / 3 | 12.2 / 14.2; 12.3 / 13.5 |
| Part 1 PO-1 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 14.9 / 14.4; 11.2 / 14.5 |
| Part 1 PO-2 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 13.5 / 16.8; 12.2 / 17.0 |
| Part 1 G1 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 13.2 / 13.4; 11.2 / 12.8 |
| Part 1 G2 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 13.5 / 15.9; 11.8 / 14.5 |
| Part 1 G3 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 7.4 / 9.8; 6.6 / 11.3 |
| Part 1 G4 | right | right | right | right | Certified, no AI | 0 / 0; 0 / 0 | 2.0 / 2.4; 1.2 / 2.3 |
| Part 1 N5 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 10.2 / 11.9; 20.1 / 10.4 |
| Part 1 N3 | right | refused | right | right | accepted | 2 / 3; 2 / 3 | 14.2 / 14.3; 12.9 / 14.9 |
| Part 1 N4 | right | wrong | right | right | accepted | 2 / 3; 3 / 3 | 9.9 / 14.0; 12.2 / 13.0 |
| Part 1 G1, first ask | right | right | right | right | accepted | 2 / 3; 2 / 3 | 12.7 / 15.4; 12.7 / 12.6 |
| Part 1 G1, reworded reply | right | right | right | right | accepted | 2 / 3; 2 / 3 | 15.3 / 20.2; 14.1 / 11.9 |
| Part 3 Q1 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 7.2 / 6.8; 7.7 / 10.0 |
| Part 3 Q2 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 6.3 / 8.1; 5.8 / 7.3 |
| Part 3 Q3 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 7.2 / 7.4; 7.5 / 7.8 |
| Part 3 Q4 | refused | right | right | refused | accepted; R2 no rows, no review | 2 / 3; 2 / 2 | 8.8 / 11.3; 9.3 / 6.7 |
| Part 3 Q5 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 9.2 / 10.3; 10.1 / 9.0 |
| Part 3 Q6 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 10.4 / 11.8; 9.7 / 11.7 |
| Part 3 Q7 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 13.8 / 18.1; 12.5 / 13.8 |
| Part 3 Q8 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 9.0 / 9.3; 8.1 / 8.2 |
| Part 3 Q9 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 7.3 / 8.0; 5.3 / 6.7 |
| Part 3 Q10 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 9.9 / 12.1; 13.2 / 11.0 |
| Part 3 Q11 | right | right | right | right | accepted | 3 / 5; 3 / 4 | 13.4 / 20.6; 10.3 / 10.3 |
| Part 3 Q12 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 14.4 / 10.5; 6.9 / 9.5 |
| Part 3 Q13 | right | right | right | right | Certified, no AI | 0 / 0; 0 / 0 | 2.4 / 2.0; 2.1 / 2.2 |
| Part 3 Q14 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 12.6 / 14.5; 11.5 / 13.2 |
| Part 3 Q15 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 9.2 / 8.5; 6.8 / 9.1 |
| Part 3 Q16 (should ask back) | right | right | right | right | asked back, no review | 2 / 1; 2 / 2 | 9.8 / 6.4; 10.0 / 8.5 |
| Part 3 Q17 (should ask back) | right | right | right | right | asked back, no review | 1 / 1; 1 / 1 | 4.6 / 3.2; 3.6 / 4.0 |
| Part 3 N1 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 10.2 / 10.6; 8.7 / 10.3 |
| Part 3 N2 | right | right | right | right | accepted | 3 / 4; 3 / 4 | 9.3 / 10.4; 8.1 / 10.4 |
| Part 3 N3 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 15.2 / 16.3; 12.7 / 15.1 |
| Part 3 N4 | right | right | right | right | accepted | 2 / 3; 2 / 3 | 13.4 / 12.1; 11.4 / 11.5 |
| Part 3 N5 | refused | right | refused | right | R1 asked back, no review; R2 accepted | 1 / 1; 3 / 4 | 5.9 / 6.0; 9.6 / 11.1 |

## What was run

- **Questions:** the pre-release Ask gate for the Snowflake app.
  - It holds 38 questions an outside tester asked about an NBA dataset, with the answers they checked in SQL.
  - Part 1 asks most questions in a fresh chat. Part 3 asks 22 in one long chat, with follow-ups.
  - Each run asked every question twice (2 rounds, 76 answers). The gate's own checks score the answers.
- **Same build, model and data:**
  - Both runs used the same code, Claude Sonnet 5.5 through Snowflake Cortex, and the gate's Snowflake copy of the tester's project.
  - That project has 4 certified saved queries, so 4 of 76 answers need no AI.
  - Each run started from its own identical copy of the project folder, so the first run's history and drafts could not reach the second.
- **Only the setting differed:** `ZLENS_ASK_RESULT_REVIEW=0` for one run, `=1` for the other.
- **One answer at a time.** The provider usage ledger (`ZLENS_PROVIDER_USAGE_LEDGER`) gives each answer's exact calls and tokens. Seconds are measured end to end, from the request to the answer.
- **Scoring:**
  - **Right:** the gate's check passed.
  - **Refused or no answer:** no answer was given (not run, "Not in this data", asked back when an answer was due), or the answer was missing or ran out of time.
  - **Wrong:** an answer was given with the wrong figures. For the two questions that should be asked back, answering with data counts as wrong.

### How the run with the review on was completed

The run with the review on started on 25 November. It stopped after 29 answers, because the development account's warehouse reached its resource monitor quota. Once the quota was raised, the run was finished on 26 November.

- **Kept: the first 26 answers.** These are round 1: all of Part 1, and Part 3 Q1 to Q10. All 26 finished before the quota hit. The last kept answer's query ran 12.5 s before the first query that failed.
- **Dropped: the answers the quota touched.**
  - Part 3 Q11 and Q12 failed with the quota error.
  - Part 3 Q13 was answered right (Certified, no AI), but it ran after the quota hit.
  - Q14 was cut off when the run was stopped and never scored.
- **Resumed: the other 50 answers,** from round 1, Part 3 Q11.
  - The code was rebuilt from the commit that merged this measurement, whose tree is the same as the build used on 25 November.
  - The project copy, settings and model route were the same, and calls went to the same ledger.
  - `measure.mjs --skip 26 --keep-from <partial run>` asked only the rest, and the kept and new answers were merged into one run.
- **One difference from the run with the review off: a new chat in Part 3, round 1.**
  - Part 3 is one long chat, and the resumed Q11 to N5 of round 1 were asked in a new chat.
  - So those 12 answers did not have Q1 to Q10 before them, as they did with the review off.
  - Round 2 is not affected.
- **No query waited in the warehouse queue:** 44 queries, mean 0.14 s, longest 0.55 s.

### Cost

- **AI credits:** tokens at Snowflake's published Cortex `AI_COMPLETE` rate for `claude-sonnet-5-5`, 1.20 credits per million input tokens and 6.00 per million output tokens.
  - The whole measurement used 7.08 AI credits, about $21 at $3 per credit.
  - With the review off: 3.42. With it on: 3.66, of which 0.24 went to the answers dropped on 25 November.
- **Warehouse:** about 31 minutes in all on X-Small, at most about half a warehouse credit. This figure was not read from Snowflake.

## Follow-up

- **A set with wrong but plausible answers.** This gate is mostly answered right already, so the review had nothing to catch.
  - What would settle it is a set where AI-drafted answers return rows that look right but are wrong. For example: a fresh install with nothing certified, and harder questions with joins, grains and time windows.
  - Measure there, with the same rule.
- **The repository's insurance benchmark set** could be part of that. It is in the separate benchmarks repository and runs on DuckDB through Claude Code or the Anthropic API, not through Cortex, so it is not the same model route.

## Caveats

- **Small set.** Two samples per question is few. Answers move between runs with nothing changed: the run with the review off differs between its rounds on 4 of 38 questions, and the run with it on on 2.
- **Mostly right already.** This gate's questions are mostly answered right already (72 of 76 with the review off).
  - A shape-only review can't see business meaning, which is the day-one risk on a fresh install.
  - Certifying the most-asked questions against the old report covers that risk. The certify-first guide on Ask's home leads people there.
- **When the review runs.** Only on the first draft of an AI-drafted answer that returned rows, with more than 30 s left. Refusals, questions asked back and certified answers never reach it.
- **Different chat history in part of round 1.** The 12 resumed answers of Part 3, round 1 had a shorter chat history than with the review off (see above).
