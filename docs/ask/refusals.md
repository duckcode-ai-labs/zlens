# When Ask refuses

If ZLens cannot answer a question safely, it does not guess. It runs no
query and tells you why. A refusal with a clear reason is a correct answer:
it means the data or the definitions you need are not in the project yet.

{{ clip("ask-refusal") }}

## What you see

Ask the sample project `What is our employee headcount by department?`:

1. The trust line reads **Couldn't run this query**.
2. The reason follows, for example: `No query was run because the tables Ask
   searched do not hold it: no listed table or column holds employee or
   department information …`
3. The status line reads **No answer**, with the steps Ask took and what it
   looked for and missed.

ZLens keeps no draft for a refusal.

## Common reasons

| Ask says | What to do |
|---|---|
| **Nothing in this project answers this question** | Add or review the missing metric, dimension, relationship or table, then ask again. |
| **No matching data**, for a period, a name or a set of filters | The query would run, but nothing matches. Check the spelling or widen the filter. |
| **One detail is missing** | Answer the question Ask asks (shown as **Needs clarification**), and it carries on. |
| A certified relationship or approved allocation is needed | Ask will not invent a join between tables. Define the relationship in **Modeling**. |
| No AI model is configured | Set up an [AI provider](../get-started/ai-provider.md). Ask needs one to read the question. |
| AI-written SQL is turned off for this project | Only certified saved queries and semantic metrics can answer. Certify a saved query for the question. |
| **Policy or permissions blocked this query** | The query touches data your project's policy excludes. |
| Ask is scoped to a domain that no longer exists | Clear the **Scope** or pick another domain. |

## See exactly why

Click **How it was answered**. Each step shows whether it was done or skipped,
and the last step, **No answer**, gives the reason. For example, a step can
say **No certified saved query matches this question.** or **The semantic layer has
no metric or dimension for part of this question.**

See [How Ask answered](how-it-answered.md).

## Turn a refusal into an answer

1. Find the gap in **How it was answered**.
2. Add what is missing: a dbt model or column, a semantic metric, a
   relationship in **Modeling**, or a certified saved query.
3. Run `npm run sync` if you changed dbt.
4. Ask again.
