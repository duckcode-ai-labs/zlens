# Ask about an App

Every App page has its own Ask box. Questions asked there stay inside that
App: Ask reads the page's current results, each tile's source and trust
label, and the filters on screen.

## Ask

1. Open an App page and let it finish running.
2. In **Ask about** *App name*…, type a question, for example
   `Which customer leads this table?`
3. Click **Ask**.

Under the box, the scope line reads **Scoped to** *App* · *page*, with chips
for the domain and any filters, such as **Domain: general**. A panel titled
**Ask about** *App name* opens with the answer.

## Read the answer

For a question about what the page shows, Ask answers from the page's own
results. It runs no new query, and the answer cites each tile it read, for
example:

```text
Source on "Overview": "Top customers by lifetime spend" reads saved query Top customers by lifetime spend (…) — Certified: Runs a certified saved query exactly as it was reviewed.
```

The answer's trust is the weakest tile it read. The answer shows it as a
label, and the result card is titled, for example, **Answer from this App
(certified tiles)**:

| Label | Means |
|---|---|
| **Certified** | Every tile it read runs a certified source. |
| **Governed** | It read governed tiles. |
| **Needs review** | A tile it read needs review. Check that tile's source before relying on the answer. |

Questions that need more than the page, such as "why" questions or
forecasts, go through the normal [Ask](../ask/index.md) steps, still limited
to this App's domain and filters.

## If the page has not run

Ask needs the page's results:

- Before the page finishes, the box says **This page has not finished
  running: Ask can see its saved queries and filters, not its results yet.**
- If the results are too old or missing, Ask says it **can't see this page's
  current results** and asks you to refresh the page and ask again. Results
  stay available to Ask for 15 minutes after the page runs.

Without an AI provider, Ask still reads the rows back from the page and says
that no AI model wrote the answer.

## One conversation per page

Each App page keeps its own conversation. Come back to the page later, or
reload it, and the conversation continues. A question asked on another page,
or in the main **Ask**, never mixes into it.

## Ask about one tile

A tile's **⋯** menu has **Ask about this chart** (or **Ask AI about this**).
