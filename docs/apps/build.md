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
4. Pick a **Starting layout**: **Executive Brief**, **Operational Dashboard**,
   **Investigation** or **Blank canvas**.
5. Leave **Only certified data** on. **Also let me try data that needs review**
   is useful while exploring, but a page that uses such data cannot publish
   until the data is certified.
6. Click **Generate editable App** (AI) or **Open blank Studio** (manual).

App Studio opens. The App is a private local draft; the header says
**Saved locally**.

You can change the data rule later in the App's settings: **Data rule** is
**Only certified data** or **Also allow data that needs review**.

### Review what AI picked

With **Describe with AI**, App Studio shows **Review the plan** before anything
is applied. Each source shows its type and trust, such as **Dataset ·
Certified**, the tiles it creates, and a short **Why:** line with the reason AI
picked it. Notes from the planner, for example a tile it could not add, are
listed under the header. With **Only certified data**, AI is given certified
data only.

## 2. Add tiles

The left panel has three tabs: **Data**, **Pages** and **Filters**.

To add a tile from a saved query:

1. On the **Data** tab, open the source menu at the top and choose **Saved
   queries and all sources…**.
2. Find your data with **Search Datasets, Metrics and saved queries**. Each
   row shows its type (**Dataset**, **Metrics** or **Saved query**) and its
   trust: **Certified** or **Needs review**. Certified Datasets are listed
   first, then Metrics, then saved queries, then data that needs review.
3. Click **Add Table**, **Add Chart** or **Add KPI**.

The tile appears on the page with its rows. Its **Tile settings** panel shows
**Data & trust**, for example **Certified** and the saved query's file.

You can also build a tile from fields: pick a Dataset in the source menu, then
click a measure or a dimension. To start from a database table, choose **Start
from a table…** in the source menu; ZLens checks the table once and turns it
into a Dataset in the App's domain. Data marked **Needs review** shows
**Allow data that needs review & add…** instead.

Other ways to add content:

- **Add tile** on the page, or **Draft with AI** on an empty page.
- **Heading** and **Text** under **Page elements**.
- **Ask AI** in the top bar to change the page with AI.

## 3. Arrange pages

- **Readers see this page as**: **Dashboard**, **Report** or **Custom layout**.
- Add a page with **+** next to the page tabs, or **New page** on the
  **Pages** tab.
- Use **Undo** and **Redo** freely.
- A tile's **⋯** menu has **View DQL and SQL**, **Change with AI**,
  **Tile settings**, **Duplicate** and **Remove tile**.

## 4. Add filters

1. Open the **Filters** tab and click **New filter**.
2. Set a **Display label** and a **Control**: **Searchable dropdown**,
   **Searchable multi-select**, **Date range** or **Single date**.
3. Choose **Apply to**: **This page** or **All compatible pages**, and the
   **Linked tiles**.
4. Click **Create filter**.

## 5. Preview

- **Preview** shows the page exactly as readers will see it. **Edit** goes back.
- **Run** runs every tile on the page.

## 6. Publish

1. Click **Publish**.
2. ZLens checks the App. If something blocks publishing, the dialog lists
   **N fixes before publishing**, such as a page that has not run, a tile that
   needs review, or a filter that is not wired to any tile. Each fix has a
   button.
3. When the dialog says **Ready to publish** and **All checks passed**, click
   **Publish to Project**.

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
