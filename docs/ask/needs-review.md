# Answers that need review

When no certified saved query or semantic metric answers a question, Ask can write
SQL from your tables with AI. That answer may well be right, but nobody has
checked it yet, so ZLens labels it. To keep it, save it: it waits as a draft
until someone reviews and certifies it.

{{ clip("ask-review") }}

## What you see

For a question such as `How many orders were placed at each store location?`
in the sample project:

1. The trust line reads **AI-generated answer**, with the checks it passed,
   for example **3 checks passed**: the same checks **How it was answered**
   lists.
2. The answer says the figures first, then how Ask read the question, then one
   source line, for example `Source: SQL written by AI from the orders and
   locations tables, because no certified saved query or metric answers this;
   review it before relying on the numbers.`
3. The result card says `AI-generated`.
4. **Save as saved query** on the answer keeps it. Ask saves nothing on its
   own.

## Save, review, certify

{{ video("ask3-ai-to-certified") }}

1. Click **Save as saved query** on the answer. A small dialog shows the name
   and the **Owner**; change them if you need to, then click **Save draft**.
   ZLens says **Saved as a draft. Review it**.
2. Click **Review it**, or open **Saved queries**: the draft is on the
   **Drafts** tab.
3. Click **Run** and look at the rows. Read **How it's worked out**, one line
   in plain words, and the checks. The SQL is folded under them.
4. To change the **Saved query name**, **Domain** or **Owner**, set a clear
   description or add a test, click **⋯ › Open in builder**. These fields are
   in the **Details** box.
5. Click **Certify**. If the draft has no Domain yet and your project has
   Domains, the saved query editor asks for one first: a Domain, or **Global /
   cross-domain** for an answer that spans Domains. AI wrote the draft, so
   Certify then asks you to confirm you reviewed it: click **I reviewed it —
   certify**.

The draft is named after the question, here `how_many_orders_placed_each_store_location`,
unless you change the name. When every table the answer reads is listed in one
Domain's **Source systems** (in the sample, `orders` and `locations` are both in
**commerce**), the draft is saved in that Domain and its **Domain** is already
set. When the tables belong to more than one Domain, or to none, the draft is
saved in `blocks/_drafts/` with no Domain, and you pick one when you certify.

**Saved queries** lists the drafts most asked first. A question many people
ask is a good one to certify first.

Comparing the result with an old report is optional: **⋯ › Compare with an
old report** on the saved query's page. See
[Prove the numbers match](../guides/migrate.md#prove-the-numbers-match).

When it passes, the saved query is **Certified** and is saved in its Domain under its
name. A certified saved query is available to Apps because it is certified, so it
carries no `app-source` tag. Ask uses it from then on: the
same question now gets a **Certified answer**. See
[Save and certify](../blocks/certify.md).

## Optional: a second look at the result

AI-written SQL can run cleanly and still compute something else: one row per
country where the question asked for one number, or a date column that came
back empty because the text did not parse. With the result review on, Ask
checks each AI-drafted result before it answers:

1. One more AI call sees the question, the SQL and the result's **shape**:
   how many rows, how many distinct and empty values each column has, and
   whether rows repeat. It never sees a value from the result.
2. If it names a concrete defect, Ask revises the SQL once, with that reason.
   The revision is the answer only if it runs and returns rows; otherwise the
   first answer stands.
3. The run's details list the check as **Checked the result against the
   question**, with **Answers it** or **Asked for a revision**.

It applies to every AI-drafted answer, including one drafted straight from
the question; certified and governed answers are not checked. It costs about
one AI call per AI-drafted answer (median 3.6 seconds on Claude), so it is
**off by default**. Turn it on in `dql.config.json`; Ask reads it at every
question:

```json
{ "agent": { "resultReview": { "mode": "on" } } }
```

`ZLENS_ASK_RESULT_REVIEW=1` turns it on and `=0` off for one server or
command, whatever the project says.

## What can be saved

Only an answer that ran SQL has a query to save. Evaluation runs
(`zlens agent eval`) never write drafts.

## Other labels you may see

- **Answer from Metrics**: built from semantic metrics and dimensions, with no
  AI-written SQL. If ZLens had to guess how to group a dimension, the note says
  **Review required** and asks you to check the mapping.
- **AI-generated** on an App page answer: the answer read an App tile whose
  data is not certified. See [Ask about an App](../apps/ask-about-an-app.md).
- On the command line, `zlens agent ask` prints
  `! AI-generated · review required` and the draft path:
  `Review draft saved: <path>`.
