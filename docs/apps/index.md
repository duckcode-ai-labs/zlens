# Read an App

An App is a set of dashboard and report pages built from saved queries. Every tile
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

Each card shows how many **Pages** the App has and when it was last
**Updated**. A certified App's card says who published it as certified and
when, for example **App certified by Kranthi · 21 Oct**.

The App opens on its first page. At the top you see the App's name and its
trust badge, for example **All data certified by Kranthi · 21 Oct** or
**2 of 3 tiles certified**.
**View** and **Edit** switch between reading and building; see
[Build an App](build.md).

## Read the trust on each tile

Each tile has a trust label:

| Label | Means |
|---|---|
| **Certified by** *name* **·** *date* | Runs certified data exactly as it was reviewed, and says who certified it and when, for example **Certified by Kranthi · 21 Oct**. |
| **Governed** | Built from approved semantic metrics and dimensions. |
| **Needs review** | Uses data nobody has certified yet. |
| **Blocked** | Cannot run, for example because of a policy. |

Data certified before ZLens recorded who certified it says **Certified · 21 Oct**,
or just **Certified**. Other labels also say how fresh the result is, such as
**Updated just now**.

Click the label to open the tile's receipt. It shows the **Source**, the
**Checks passed** when the data was certified (for example what one row is,
how numbers are shown, and its tests), the **Owner**, the **Filters** applied,
the number of **Rows**, and when it was **Last refreshed**. Ids, the source
file and the fingerprints of the result and the SQL are under
**Technical details**, which starts closed. **Show the query and SQL** opens
what ran.

The bar above the tiles summarizes the page, for example
**All 1 tile certified**. Turn on **Trust lens** to highlight each tile's
trust.

Some pages have a **Summary (auto-written)** above the tiles: a few sentences
about the page's current numbers. It appears only when the page's author added
it. The **Evidence & review appendix** at the bottom says when the page was
last refreshed and which tiles need review; ids are under
**Technical details**.

!!! note
    People who only read Apps never see draft or needs-review tiles. Those
    appear only while you build.

## Words used in App Studio

App Studio uses one small set of words:

| Word | Means |
|---|---|
| **App** | A set of dashboard and report pages you publish together. |
| **Page** | One dashboard or report inside an App. A reader switches pages with **Pages**. |
| **Tile** | One KPI, chart, table or text box on a page. |
| **Data** | What an App reads, chosen from one list on **Data for this App** or with **+ Add data…**. Each item says where it comes from: **table**, **saved query** or **Metrics**. |
| **Field** | A measure to add up or count, or a dimension or time to group by. You build tiles by picking fields. |
| **Filter** | A control above the tiles that narrows what the page shows, such as a region or a date range. |
| **Domain** | A Domain groups data by business area, like Sales or Finance. It filters the lists; it is not a kind of data. |
| **Table** | A table in your database. ZLens checks it once (**Check and add** → **Check and use**) before you use it. |
| **Checked · Needs certifying** | ZLens checked the data (it runs, what one row is, number formats) and you can build tiles from it, but nobody has certified it yet. It is certified on purpose before the App is published. |
| **Saved query** | A reusable, reviewed query. Files and the CLI call it a block (a `.dql` block file). Its result's columns are its fields, with no review step: grouped by its own columns its values show as they are, otherwise numbers add up (**Sum**) and averages are never added up. |
| **Make row-level** | An action under a saved query's **⋯**: ZLens checks what one row is and records it, for row-safe measures such as distinct counts. |
| **Related table** | A table that checked data points to through a many-to-one join (each order has one customer). Its fields show under the data as **Orders → Customer**, and totals stay the same. |
| **Metrics** | Measures and dimensions from a semantic model. |
| **Certified** | A person reviewed the data and vouched for it (**I vouch for this — certify**, or **Certify** in Block Studio). ZLens always says who and when: **Certified by** *name* **·** *date*, and the receipt lists the checks that passed. |
| **Certified by** | The person who certified the data: the signed-in person with a host, otherwise your git `user.name`. You read **Certified by you** for data you certified. Older data shows **Certified · date** or **Certified**. |
| **Unpublished changes** | Changes to an App that only you can see until you publish. |
| **Summary** | A short auto-written paragraph about a page's numbers. Off unless the author adds it. |
| **Technical details** | Ids, hashes and fingerprints, kept out of the way under a toggle that starts closed. |
| **Needs review** | Nobody has certified the data yet. A page that uses it cannot publish. |

Files, the API and the reference docs use a few more technical words: a
checked table or a row-level saved query is a *Dataset* there, and a saved
query is a *block*.

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
header, to see the page's sources: tiles, saved queries, dbt models and tables. See
[Lineage](../lineage/index.md).
