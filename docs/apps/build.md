# Build an App

An App is a set of pages for a team or a decision, built from Datasets,
Metrics and saved queries. You build it in **App Studio** as a private draft,
then publish it as files in your project. The words App Studio uses are listed
in [Words used in App Studio](index.md#words-used-in-app-studio).

## 1. Start a new App

1. In the left rail, click **Apps**.
2. Click **Build new App** if the form is not already open.
3. Choose how to start:
    - **Describe with AI**: answer **What decision should this App support?**
      AI picks certified data and drafts a first version. You review the data it
      chose and every tile before anything is applied. Needs an
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

The App is a private local draft; the header says **Saved locally**. With
**Start manually**, App Studio opens on **Data for this App** first. With AI,
it opens on the canvas.

You can change the data rule later in the App's settings: **Data rule** is
**Only certified data** or **Also allow data that needs review**.

### Review what AI picked

With **Describe with AI**, App Studio shows **Review the plan** before anything
is applied. Each source shows its type and trust, such as **Dataset ·
Certified**, the tiles it creates, and a short **Why:** line with the reason AI
picked it. Notes from the planner, for example a tile it could not add, are
listed under the header. With **Only certified data**, AI is given certified
data only.

## 2. Choose the data

**Data for this App** lists the App's data on the left (**This App's data**)
and an **Add data** list on the right with three tabs:

- **Datasets & Metrics**: data with fields, listed certified first.
- **Saved queries**: blocks without fields; their result is used as it is.
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

Click **Open canvas with N sources**, or **Skip, start empty**. You can add
more later: on the canvas, the **Data** tab's source menu lists **This App's
data** first, then **+ Add data…**.

## 3. Add tiles

The left panel has three tabs: **Data**, **Pages** and **Filters**. On the
**Data** tab, choose a source from **This App's data**:

- **A Dataset or Metrics**: click a measure or a dimension. A new tile appears
  on the page; add more fields, then click **Add to page**.
- **A saved query**: under **Add as**, click **Table**, **Chart** or **KPI**.
  Saved queries have no fields, so you cannot pick measures and dimensions.

The tile shows its rows. Its **Tile settings** panel shows **Data & trust**,
for example **Certified** and the Dataset or saved query it uses.

Other ways to add content:

- **Add tile** on the page, or **Draft with AI** on an empty page.
- **Heading** and **Text** under **Page elements**.
- **Ask AI** in the top bar to change the page with AI.

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
