# Build an App

An App is a set of pages for a team or a decision, built from Datasets,
Metrics and saved queries. You build it in **App Studio** as a private draft,
then publish it as files in your project. The words App Studio uses are listed
in [Words used in App Studio](index.md#words-used-in-app-studio).

{{ clip("app-builder") }}

## 1. Start a new App

1. In the left rail, click **Apps**.
2. Click **Build new App** if the form is not already open.
3. Choose how to start:
    - **Describe with AI**: answer **What decision should this App support?**
      AI picks certified data and drafts a first version. You check the data it
      chose and every tile before anything is applied. Works best with an
      [AI provider](../get-started/ai-provider.md).
    - **Start manually**: answer **What should this App be called?**
4. Pick a **Domain**, or leave **All domains**. Lists of data start on this
   domain; you can still pick data from any domain.
5. Pick a **Starting layout**: **Executive Brief**, **Operational Dashboard**,
   **Investigation** or **Blank canvas**.
6. Leave **Only certified data** on. **Also let me try data that needs review**
   is useful while exploring, but a page that uses such data cannot publish
   until the data is certified.
7. Click **Generate editable App** (AI) or **Open blank Studio** (manual).

The App is a private local draft; the header says **Saved locally**. Both ways
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

Without an AI provider, a simpler built-in planner picks the data and the
review says **Deterministic planner fallback**. Its **Why:** line names the
words of your request the data matched and its trust, for example *Its name
and description match “customers” · Certified saved query*.

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
and an **Add data** list on the right with three tabs:

- **Datasets & Metrics**: data with fields, listed certified first.
- **Saved queries**: blocks without fields; their result is used as it is,
  until you **Add fields** (see below).
- **Database tables**: a table becomes a Dataset after ZLens checks it once.

Search with **Search Datasets, Metrics and saved queries**, and narrow the list
with the domain buttons (**All** or one domain). The **Data rule** line shows
**Only certified data** or **Also allow data that needs review**; **Change**
switches it.

Each row shows its type, its trust (**Certified** or **Needs review**), its
domain and owner. Click a row to see its **Measures**, **Dimensions** and
**Time**, or a saved query's **Columns**; **Show 10 sample rows** reads a few
rows of a Dataset.

- Click **Add to App**. The row then says **Added**, with **Remove**.
- Data marked **Needs review** shows **Allow data that needs review & add**
  while the App allows only certified data.
- On **Database tables**, click **Check and add**, check the numbers, and click
  **Certify and use this data**. The new Dataset is added to the App.
- On **Saved queries**, **Add fields** gives a saved query fields (see
  [Add fields to a saved query](#add-fields-to-a-saved-query)).

Click **Open canvas with N sources**, or **Skip, start empty**. You can add
more later: on the canvas, the **Data** tab's source menu lists **This App's
data** first, then **+ Add data…**.

## 3. Add tiles

The left panel has three tabs: **Data**, **Pages** and **Filters**. On the
**Data** tab, choose a source from **This App's data**:

- **A Dataset or Metrics**: click a measure or a dimension. A new tile appears
  on the page; add more fields, then click **Add to page**.
- **A saved query**: under **Add as**, click **Table**, **Chart** or **KPI**.
  Saved queries have no fields, so you cannot pick measures and dimensions
  until you click **Add fields**.

### Add fields to a saved query

A saved query can become a Dataset, so you can build tiles from its
**Measures** and **Dimensions**:

1. Choose the saved query on the **Data** tab and click **Add fields** (or
   **Add fields** on its row in **Add data → Saved queries**).
2. **Check the numbers** reads the saved query's columns and checks them
   against its rows: *Each row is one …* names the column that is different on
   every row, **Numbers** lists what to add up or count (switch any off, and
   pick **Number**, **Money** or **Percent**), and **Group and filter by** lists
   the rest.
3. Click **Check and add fields**. ZLens writes the fields into the same saved
   query file (same name, same place; no copy) and runs the same certification
   checks as **Certify and use this data**.
   - Checks pass: the saved query is a **Certified** Dataset.
   - Checks fail: it keeps its fields and stays **Needs review**.
4. Click **Use its fields**. The **Data** tab shows its **Measures** and
   **Dimensions**.

A certified saved query shows *Adding fields sends this saved query back for
review.* If its checks pass it is certified again right away. If they fail,
nothing changes until you click **Send for review and add fields**, which adds
the fields and leaves it **Needs review**. A saved query that asks for values
(parameters) cannot get fields yet.

The tile shows its rows. Its **Tile settings** panel shows **Data & trust**,
for example **Certified** and the Dataset or saved query it uses.

Other ways to add content:

- **Add tile** on the page, or **Draft with AI** on an empty page.
- **Heading** and **Text** under **Page elements**.
- **Ask AI** in the top bar to change the page with AI.

An AI proposal on the canvas opens **Review the tiles**. When it uses data the
App does not have yet, the review lists it as **New data for this App:** with
its type, trust and **Why:** line. **Apply N changes** adds that data to
**This App's data**, the same way **Add to App** does.

## 4. Arrange pages

- **Readers see this page as**: **Dashboard**, **Report** or **Custom layout**.
- Add a page with **+** next to the page tabs, or **New page** on the
  **Pages** tab.
- Use **Undo** and **Redo** freely.
- A tile's **⋯** menu has **View DQL and SQL**, **Change with AI**,
  **Tile settings**, **Duplicate** and **Remove tile**.

## 5. Add filters

1. Open the **Filters** tab and click **New filter**.
2. Set a **Display label** and a **Control**: **Searchable dropdown**,
   **Searchable multi-select**, **Date range** or **Single date**.
3. Choose **Apply to**: **This page** or **All compatible pages**, and the
   **Linked tiles**.
4. Click **Create filter**.

A new filter starts linked to the tiles of the Dataset you picked the field
from. When other Datasets in the App have an approved field with the same
name and kind, **Also filter these tiles?** lists each as *Dataset · field*,
unchecked. Check one to link its tiles too; nothing is linked by name on its
own.

## 6. Preview

- **Preview** shows the page exactly as readers will see it. **Edit** goes back.
- **Run** runs every tile on the page.

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
