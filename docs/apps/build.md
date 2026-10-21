# Build an App

An App is a set of pages for a team or a decision, built from Datasets,
Metrics and saved queries. You build it in **App Studio** as a private draft,
then publish it as files in your project. The words App Studio uses are listed
in [Words used in App Studio](index.md#words-used-in-app-studio).

{{ clip("app-builder") }}

## 1. Start a new App

1. In the left rail, click **Apps**.
2. Click **Build new App** if the form is not already open. With an
   [AI provider](../get-started/ai-provider.md) connected it opens on
   **Describe with AI**; without one it opens on **Start manually**.
3. Choose how to start:
    - **Describe with AI**: answer **What decision should this App support?**
      AI picks certified data and drafts a first version. You check the data it
      chose and every tile before anything is applied. Without an AI provider
      this tab says **Connect an AI provider to describe an App**, with
      **Connect an AI provider** (Settings → AI provider) and **Try keyword
      suggestions** (see [Without an AI provider](#without-an-ai-provider-keyword-suggestions)).
    - **Start manually**: answer **What should this App be called?**
4. Pick a **Domain**, or leave **All domains**. Lists of data start on this
   domain; you can still pick data from any domain.
5. Pick a **Starting layout**: **Executive Brief**, **Operational Dashboard**,
   **Investigation** or **Blank canvas**.
6. Leave **Only certified data** on. **Also let me try data that needs review**
   is useful while exploring, but a page that uses such data cannot publish
   until the data is certified.
7. Click **Generate editable App** (AI), **Suggest from keywords** (no AI
   provider) or **Open blank Studio** (manual).

The App is a private draft; the header says **Unpublished changes (only you
can see them)**. Both ways
open on the Data step first: with **Start manually** it is **Data for this
App**; with AI it shows the data AI picked (see below).

You can change the data rule later in the App's settings: **Data rule** is
**Only certified data** or **Also allow data that needs review**.

### Build with AI: describe, check the data, build pages, review tiles

With **Describe with AI**, AI works in four steps and nothing is applied until
you say so.

1. **Describe.** While AI plans, the Data step says **AI is picking data** and
   shows its progress: **Understanding your decision**, **Finding certified
   Datasets, Metrics and saved queries**, **Checking trust and capabilities**
   and **Preparing source review**.
2. **Check the data AI picked.** The Data step says **AI picked N sources**,
   **For:** your goal, and *Check the data before AI builds pages. Remove
   anything you don’t trust.* Each pick under **AI picks** shows its type,
   trust and domain, such as **Dataset · Certified · Commerce**, **Creates N
   tiles**, and a **Why:** line with the reason AI picked it.
    - **Remove** moves a pick to **AI suggestions**; **Add back** returns it.
    - **Notes from AI** lists what the planner could not do, in plain words
      with the data's name, for example *Top Customers covers only part of
      what you asked.* or *Journey Customers can't answer this with its
      approved fields yet.*
    - **Not covered yet** lists the parts of your request no data answers.
      **Generate draft DQL that needs review** drafts a Dataset for one of
      them; it needs **Also allow data that needs review**.
    - If AI needs a choice from you, **AI needs one more decision** asks it;
      answer it, or click **Re-run proposal**.
    - The **Add data** list on the right works as for a manual App. **Add to
      App** makes AI plan again with that data, and the progress shows while
      it does.
    - With **Only certified data**, AI is given certified data only.
3. **Build pages.** Click **Build pages with N sources**. **Discard** drops
   AI's picks and leaves you on **Data for this App** to pick data yourself.
4. **Review the tiles.** The canvas shows the proposed tiles, and the
   **Review the tiles** panel lists them. **Skip** leaves a tile out and
   **Keep** brings it back, here or on the tile itself. Click **Apply N
   changes** to add the tiles and their data to the App, or **Discard**.
   **Back to data** returns to the AI picks until you apply.

### Without an AI provider: keyword suggestions

With no AI provider connected, nothing reads your request, so App Studio never
says AI picked anything. **Try keyword suggestions** uses a simple built-in
matcher instead, and every place it shows up says so:

- The Data step heading is **Suggested from keywords · no AI connected**, the
  list is **Keyword suggestions** (removed ones go to **Removed suggestions**),
  and the planner's notes are under **Notes**. The progress reads **Reading the
  words in your request**, **Matching them to certified Datasets, Metrics and
  saved queries**, and so on.
- Each suggestion's **Why:** line names the words of your request it matched
  and its trust, for example *Its name and description match “customers” ·
  Certified saved query*.
- Parts of your request no suggestion matched (such as *Keep it short and
  clear*) are listed under **Not covered yet** as notes. They are never
  publish fixes: add tiles for them yourself, or leave them out.
- The tile review on the canvas is labelled **Keyword suggestions** and says
  **Matched on:** your request.

In the Studio, one rule applies to every AI entry point. What keyword
suggestions can do is offered with the same label: the toolbar's **Suggest
tiles** (instead of **Ask AI**), **Suggest tiles from keywords** on an empty
page or in the App settings, and **Suggest from keywords** in the publish
review. What only an AI can do says **Connect an AI provider** instead:
changing one tile (**Edit with AI**) and **Design layout with AI**. With an AI
provider connected, all of these work as described above.

Whichever planner runs, a proposal never adds a tile the page already shows:
the plan's note says *Revenue by region is already on this page, so it wasn't
added again*, and the review counts only the tiles it adds.

### From Ask or an MCP client

An App that AI builds outside App Studio opens in App Studio at the Data step,
so you check the data first. Nothing is written to your project until you
publish, and publishing goes through the same checks.

- **Ask.** When you ask for an App, Ask shows a **Build Brief**: its tiles
  with their trust (**Certified**, **Metrics · Needs review**, **Draft SQL ·
  Needs review**) and **Not covered yet**. Untick what you don't want and
  click **Open in App Studio**. The data behind the tiles you kept becomes the
  App's data, and App Studio opens at **AI picked N sources**. Ask's SQL is
  never added as a tile: its question is listed under **Not covered yet**.
  The App uses **Only certified data** unless you kept data that needs review.
- **An MCP client** (Claude Code, Codex, Cursor). `build_dql_app` picks
  certified data for your description and returns a link to the draft, for
  example `http://127.0.0.1:3474/?appDraft=build_…`. Open it to continue in
  App Studio. The draft is also listed in **Apps** under **Drafts**.

## 2. Choose the data

**Data for this App** lists the App's data on the left (**This App's data**)
and one **Add data** list on the right. Everything in it has fields:

- **Table**: a Dataset made from a database table, or a table that is **Not
  checked yet**. A table becomes a Dataset after ZLens checks it once.
- **Saved query**: a block. Its fields come from its result, with no review
  step (see [Fields from a saved query](#fields-from-a-saved-query)).
- **Metrics**: measures from a semantic model.

The chips **All · Tables · Saved queries · Metrics** narrow the list to one
kind. Search with **Search tables, saved queries and Metrics**, and narrow it
by domain (**All domains** or one domain). The **Data rule** line shows **Only
certified data** or **Also allow data that needs review**; **Change** switches
it.

Each row shows where it comes from (**Table**, **Saved query** or **Metrics**),
its trust (**Certified by** *name* **·** *date*, or **Needs review**), its
domain and owner. Click a
row to see its **Measures**, **Dimensions** and **Time**; **Show 10 sample
rows** reads a few of its rows.

- Click **Add to App**. The row then says **Added**, with **Remove**.
- Data marked **Needs review** shows **Allow data that needs review & add**
  while the App allows only certified data.
- On a table that is **Not checked yet**, click **Check and add**, check the
  numbers, and click **Certify and use this data**. The new Dataset is added
  to the App, and the list says who certified it and when, for example
  **Orders · Certified by Kranthi · 21 Oct**, with the **Checks passed**: what
  one row is (the row key), how each number is shown (money stored as cents is
  shown in dollars), and its tests. You are recorded as the person who
  certified it: the signed-in person with a host, otherwise your git
  `user.name`.
- On a saved query, **⋯ → Make row-level** is only needed for row-safe
  measures (see [Make a saved query row-level](#make-a-saved-query-row-level)).

Click **Open canvas with N sources**, or **Skip, start empty**. You can add
more later: on the canvas, the **Data** tab's source menu lists **This App's
data** first, then **+ Add data…**.

## 3. Add tiles

The left panel has three tabs: **Data**, **Pages** and **Filters**. On the
**Data** tab, choose a source from **This App's data** and click a measure or
a dimension (or drag it onto a shelf). A new tile appears on the page; add
more fields, then click **Add to page**. A table, a saved query and Metrics
all work the same way.

### Fields from a saved query

A saved query's output columns are its fields, on the same shelves as any
other data: numbers are **Measures**, text and true/false columns are
**Dimensions**, and dates are **Time** fields you can group by day, week or
month (a `month` column by month and longer). **Count of rows** is always
there. ZLens reads the column names and types once, when you open or add the
saved query; nothing changes in the saved query and its trust stays its own.
**Describe with AI** and Ask's **Open in App Studio** read them the same way,
so the tiles AI proposes from a saved query use its fields too.

A tile over a saved query runs as one query over the saved query's complete
result:

- **As it is.** When the tile groups by all of the saved query's own grouping
  columns (for `monthly_revenue`, by **Month** by month), each point is one row
  of the saved query and its values show as they are.
- **Rolled up.** Any other tile adds rows up: numbers default to **Sum**, so
  **Gross Revenue** as a KPI is the total and **Gross Revenue** by quarter adds
  up three months. The tile says **Rolled up from a saved query**, and its
  receipt says *Rolled up from the certified result of monthly_revenue*.
- **Averages can't be added up.** A column named like an average or a ratio
  (`avg_`, `average`, `pct`, `percent`, `rate`, `ratio`, `_share`, `margin`)
  shows as it is only at the saved query's own grouping. Rolled up, ZLens
  refuses to sum it and offers **Min** and **Max** of it instead.

A certified saved query's tiles are **Certified**; a saved query that needs
review keeps its tiles **Needs review**. A saved query that asks for values
(parameters) has no fields: under **Add as it is**, click **Table**, **Chart**
or **KPI** to show its result.

### Make a saved query row-level

Rolling up a saved query's result is right for sums and counts of its rows.
For row-safe measures, such as a distinct count of customers or an average
over rows, make it row-level:

1. Choose the saved query on the **Data** tab and click **⋯ → Make row-level**
   (or **⋯ → Make row-level** on its row in **Add data**).
2. **Check the numbers** reads the saved query's columns and checks them
   against its rows: *Each row is one …* names the column that is different on
   every row, **Numbers** lists what to add up or count (switch any off, and
   pick **Number**, **Money** or **Percent**), and **Group and filter by** lists
   the rest.
3. Click **Check and make row-level**. ZLens writes a row-level definition
   into the same saved query file (same name, same place; no copy) and runs
   the same certification checks as **Certify and use this data**.
   - Checks pass: the saved query is **Certified** and row-level.
   - Checks fail: it is row-level and stays **Needs review**.
4. Click **Use its fields**.

A certified saved query shows *Making it row-level sends this saved query back
for review.* If its checks pass it is certified again right away. If they
fail, nothing changes until you click **Send for review and make row-level**.

The tile shows its rows. Its **Tile settings** panel shows **Data & trust**,
for example **Certified by Kranthi · 21 Oct**, the checks that passed, the
data it uses, and how many rows it shows (**12 rows**).

Other ways to add content:

- **Add tile** on the page, or **Draft with AI** on an empty page.
- **Heading** and **Text** under **Page elements**.
- **Summary** under **Page elements** adds a short auto-written summary of the
  page's numbers above the tiles. Pages have no Summary unless you add it;
  **Remove Summary** takes it off again.
- **Ask AI** in the top bar to change the page with AI.

An AI proposal on the canvas opens **Review the tiles**. When it uses data the
App does not have yet, the review lists it as **New data for this App:** with
its type, trust and **Why:** line. **Apply N changes** adds that data to
**This App's data**, the same way **Add to App** does.

### Sort and show the top N

Click **⋯** on a measure's pill on the shelves:

- **Sort**: **Ascending** or **Descending** by that measure, or **Clear**.
- **Show top**: **5**, **10**, **25**, **All**, or type another number and
  click **Show**. The tile shows that many rows, highest first.

A new bar chart over categories (not dates) is sorted by its measure,
highest first. A bar chart with more than 50 categories draws the top 25 and
says *Showing top 25 of 935 · Show all*. **Show all** draws every category;
**Top 25** goes back. A tile with its own **Show top** number draws exactly
that many.

**Filters, sort and more** in **Tile settings** has the same **Sort by** and
**Show top** controls. Both edit the same tile, so they always agree.

After **Add to page** the new tile is not selected: the next field you click
starts another new tile. To change a tile, click it first. With a tile
selected, **Delete** removes it, also while you are in its **Tile settings**
(but not while you type in a field).

When two items in **This App's data** have the same name, each shows where it
comes from, for example *Orders · Table* and *Orders · Metrics*.

## 4. Arrange pages

- **Page style**: **Dashboard**, **Report** or **Custom layout**.
- Add a page with **+** next to the page tabs, or **New page** on the
  **Pages** tab.
- Use **Undo** and **Redo** freely.
- A tile's **⋯** menu has **View DQL and SQL**, **Change with AI**,
  **Tile settings**, **Duplicate** and **Remove tile**.

## 5. Add filters

1. Open the **Filters** tab and click **New filter**.
2. Set a **Display label** and a **Control**: **Searchable dropdown**,
   **Searchable multi-select**, **Date range** or **Single date**.
3. Choose **Apply to**: **This page** or **All compatible pages**.
4. Under **Tiles**, set each tile to **Applies** or **Does not apply**.
5. Click **Create filter**.

A date control needs no list of values, so you can create it before the page
has run.

Each field in the list says where it comes from, for example *from
Customers*. The search ignores spaces, underscores and capitals, so
*customer name* finds **Customer Name**. A tile that can't take the field says
why in plain words, for example *Monthly Revenue has no Customer Name field.*

A new filter starts linked to the tiles of the Dataset you picked the field
from. When other Datasets in the App have an approved field with the same
name and kind, **Also filter these tiles?** lists each as *Dataset · field*,
unchecked. Check one to link its tiles too; nothing is linked by name on its
own.

### Applies or Does not apply

Every tile on the filter's pages gets one of two choices, and both are saved
with the page:

- **Applies**: the filter narrows the tile.
- **Does not apply**: the tile keeps showing everything, and readers see a
  **Not filtered by** *filter* pill on it. A tile that can't take the field
  (an App-wide filter on a page whose tiles don't have it) starts as **Does not
  apply**, with the reason shown.

**Does not apply** never blocks publishing. Only a tile with neither choice
does, and the publish check sends you to the Filters tab to choose. A Saved
query tile marked **Does not apply** is not filtered even when it has a
parameter with the filter's name.

### Trying a filter in the editor

The new control appears above the page. Changing its value re-runs only the
tiles it applies to, at once, with no need to press **Run**; the header says
"*Filter* applied · 1 tile updated". Tiles the filter does not apply to keep
their result and are never blanked. The values you try in the editor are
not saved for readers.

### How filters reach each tile

| Tile | How the filter applies |
| --- | --- |
| Dataset | A condition on the Dataset field the filter is mapped to. |
| Metrics | A condition on a dimension of the metric's model, also when the tile doesn't group by it (a KPI). Text search works with the DQL native compiler; with MetricFlow the tile shows **Not filtered by**. |
| Saved query (fields) | A condition on the saved query's result column the filter is mapped to, like a Dataset field. Click-to-filter works the same way. |
| Saved query (as it is) | A parameter with the filter's name (`region`, or `period_start` / `period_end` for a range), otherwise a condition on the result column the filter is linked to. |
| Draft (needs review) | The same as a Saved query tile shown as it is. Its evidence lists the filters that applied and the ones that didn't. |
| Text | Never filtered. |

### Dates

Every tile uses the same date rule:

- A date range keeps everything from the start date through the whole end
  date: `>= start` and `< the day after end`. 1–31 March includes rows late on
  31 March.
- You can set just one end. Only a start means "from that day" and the
  control says **From 1 Mar 2025**; only an end means "until that day",
  **Until 30 Jun 2025**. Clearing both ends removes the filter.
- A single date is that whole day, so it also matches timestamp columns.
- A relative date, such as the last 7 days, becomes a date range first, with
  today taken in the filter's timezone.
- Dates are compared as calendar days on every tile, timestamp columns
  included, in the same calendar that groups a chart by day or month. A range
  ending 30 June keeps an order at 23:30 on 30 June and never adds a July
  point. The filter's timezone only decides what "today" is.
- A Saved query's `_start` / `_end` parameters receive the dates you picked;
  `_end` is the last day itself, not the day after. With only one end set, the
  other parameter receives `0001-01-01` or `9999-12-31`.

### What readers see

Readers' pills come from the run that drew the page. When a filter did not
narrow a tile, for any reason, the tile shows **Not filtered by** *filter*, and
the pill's tooltip says why. Text tiles never show filter pills.

## 6. Preview

- **Preview** shows the page exactly as readers will see it: the **Ask about**
  box, the trust line, the **Summary** if you added one, and the tiles.
  Questions typed in Preview are not sent. **Edit** goes back.
- **Run** runs every tile on the page. When every tile has run, the header says
  **All tiles up to date**.

Under **Filters, sort and more**, **Show** is **Summarise** (add up rows into
a KPI, chart or table) or **Show rows** (pick columns and how many rows; it
needs a column that is unique on every row).

On a chart, a hint says what clicking does, for example **Clicking a bar
filters other Customers tiles**, with a button to link more tiles. Table
headers show each column's type as an icon; hover it for **Number**, **Text**
or **Date**.

## 7. Publish

1. Click **Publish**.
2. ZLens checks the App. If something blocks publishing, the dialog lists
   **N fixes before publishing**, such as a page that has not run, a tile that
   needs review, or a filter that is not wired to any tile. Each fix has a
   button.
3. When the dialog says **Ready to publish** and **All checks passed**, click
   **Publish to Project**.

Data in **This App's data** that no tile uses does not block publishing. It is
not saved with the App, and the dialog says so, for example **1 data source not
used by any tile will not be saved with the App.**

Publishing writes the App as files in your project. Nothing is committed for
you. The App opens in view mode, and its badge shows its trust, for example
**All data certified**.

```text
apps/customer-overview/
├─ dql.app.json            the App: name, owners, pages, filters
├─ README.md
└─ dashboards/
   └─ overview.dqld        one file per page
```

Commit the folder from **Source control** to share it.

## Change a published App

Open the App and click **Edit**. App Studio opens a draft of the App; the
published version does not change until you publish again.

## From the terminal

```bash
zlens app ls          # list the project's Apps
zlens app show customer-overview
zlens app build .     # build every App and refresh dql-manifest.json
```
