# Read an App

An App is a set of dashboard and report pages built from blocks. Every tile
says how far to trust it, and you can ask questions about what the page
shows.

The workbench opens on **Apps**.

{{ clip("app-ask") }}

## Open an App

1. In the left rail, click **Apps**.
2. The library lists your Apps. Use the tabs (**All**, **Local drafts**,
   **Private**, **Shared**, **Favourites**) or **Search apps, domains,
   owners...** to find one.
3. Click **View** on the App's card.

The App opens on its first page. At the top you see the App's name and its
trust badge, for example **All data certified** or **2 of 3 tiles certified**.
**View** and **Edit** switch between reading and building; see
[Build an App](build.md).

## Read the trust on each tile

Each tile has a trust label:

| Label | Means |
|---|---|
| **Certified** | Runs a certified block exactly as it was reviewed. |
| **Governed** | Built from approved semantic metrics and dimensions. |
| **Needs review** | Uses data nobody has certified yet. |
| **Blocked** | Cannot run, for example because of a policy. |

The label also says how fresh the result is, such as **Updated just now**.

Click the label to open the tile's receipt. It shows the **Source**, the
**Source file**, the **Owner**, the **Filters** applied, the number of
**Rows**, when it **Ran**, and fingerprints of the result and the SQL.
**Show the query and SQL** opens what ran.

The bar above the tiles summarizes the page, for example
**All 1 tile certified**. Turn on **Trust lens** to highlight each tile's
trust.

!!! note
    People who only read Apps never see draft or needs-review tiles. Those
    appear only while you build.

## Words used in App Studio

App Studio uses one set of words for data and trust:

| Word | Means |
|---|---|
| **Data** | The data an App uses: tables, saved queries and Metrics, chosen from one list on **Data for this App** or with **+ Add data…**. Everything you add has fields. |
| **Field** | A measure to add up or count, or a dimension or time to group by. You build tiles by picking fields. |
| **Table** | A table in your database. It becomes a Dataset after ZLens checks it once (**Check and add**). |
| **Saved query** | A block. Its result's columns are its fields, with no review step: grouped by its own columns its values show as they are, otherwise numbers add up (**Sum**) and averages are never added up. |
| **Make row-level** | An action under a saved query's **⋯**: ZLens checks what one row is and writes a row-level definition, for row-safe measures such as distinct counts. |
| **Dataset** | Data with a row-level definition: a checked table, or a saved query made row-level. |
| **Metrics** | Measures and dimensions from a semantic model. |
| **Domain** | A label that filters the lists, such as `finance`. It is not a kind of data. |
| **Certified** | Someone owns the data and checked it. |
| **Needs review** | Nobody has certified the data yet. A page that uses it cannot publish. |
| **Tile** | One KPI, chart, table or text box on a page. |

## Change a filter

Filters sit above the tiles.

- Pick values in a dropdown, or set **from** and **to** dates.
- **Reset** puts a filter back to its default.
- If a filter does not apply to every tile, it says so, for example
  **Region affects 2 of 3 tiles**.

To filter the page by something the App does not offer, use **Filter by…**,
choose a field and a value, and click **Apply**. That filter is yours, for this
session only.

## Ask about the App

Type a question in **Ask about** *App name*… above the tiles and click
**Ask**. The answer uses this page's results and filters. See
[Ask about an App](ask-about-an-app.md).

## More on each tile

A tile's **⋯** menu has **How this was computed**, **View DQL**,
**Why did it move?**, **Ask about this chart**, **Open in notebook**,
**Show as** and **Download CSV**.

## Follow, share and export

| Button | Does |
|---|---|
| **Follow** | Marks the page as one you follow (**Following**). |
| **Share** | Copies a link to the page: **On this computer**, or **Read-only, on your network**. |
| **Alerts** | **Alert me when** a number falls below, rises above or changes by an amount. Alerts are checked by `zlens schedule start`. |
| **Export** | **Signed HTML**, **PNG image**, or **Print or save as PDF**. |

## See where the numbers come from

Click **Lineage** in the dashboard toolbar, or the lineage icon in the App
header, to see the page's sources: tiles, blocks, dbt models and tables. See
[Lineage](../lineage/index.md).
