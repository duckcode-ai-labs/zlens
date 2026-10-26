# How Ask answered

Every Ask run is recorded on your machine. You can see, for any answer, which
sources Ask looked at, what it skipped, the SQL that ran and the checks it
passed.

## From an answer

{{ video("ask2-how-answered") }}

1. Under the answer, click **How it was answered**.
2. The panel opens on **How it answered**. It starts with the outcome, such as
   **Answered from a certified saved query.**, and a line like
   `Worked for 52 s · 6 steps · 1 AI call`.
3. Read the steps in order:
    - **Read the question**: how Ask understood it.
    - **Certified saved queries**: whether a certified saved query answers it.
    - **Semantic layer**: whether metrics and dimensions could answer it.
    - **Governed tables** and **AI wrote SQL**: used only when nothing more
      trusted could answer.
    - **Checked before running** and **Ran on the warehouse**.
    - **Answer**, or **No answer** with the reason.

    Each step is marked **Done**, **Not used**, **Skipped**, **Failed** or
    **Not reached**. Click a step to see why, such as the AI calls and the
    SQL it wrote.

    **Checked before running** lists the checks AI-written SQL must pass
    before it runs: **Uses only tables and columns the project lists**,
    **Applies every value the question states**, **Joins do not count rows
    more than once** and **Shows names, not bare keys**. When the SQL joins
    tables a certified relationship connects, it also checks **Joins
    certified tables on their certified keys**.
4. Use the other tabs for the detail: **DQL**, **SQL**, **Data used** (the
   certified saved query, metrics, dimensions, tables, joins and filters) and
   **Checks**.
5. Click **Open full trace** for the complete record.

## Ask observability

In the left rail, under **Govern**, click **Ask observability**. It lists
every local Ask run, newest first.

{{ video("ask6-keep-trace") }}

Filter the list by:

- **Outcome**: completed, blocked, failed, cancelled and more.
- **Mode**: Ask or Research.
- **Selected tier**: **Certified**, **Semantic**, **Governed relational**,
  **Exploratory SQL**, **Clarify or gap**.
- **Trust**: **Certified**, **From Metrics**, **Review required**, **Blocked**.

Click **Open trace** on a run. The trace page starts with the decision story
and a flow chart of each decision. **Recorded events (advanced)** holds the
**Trace Tree** (the steps, nested) and the **Timeline** (where the time
went).

The trace keeps what each AI call was for, how long it took and its reply,
the checks, the SQL that ran and a sample of its rows. It does not keep full
prompts, credentials or file paths.

## From the terminal

```bash
zlens agent trace list
zlens agent trace show <trace-id>
```

To share a run with a maintainer without sharing your data, export a
**strict** bundle. It replaces identifiers with stand-ins and refuses raw
SQL, URLs, paths and secrets:

```bash
zlens agent trace export <trace-id> --out ./ask-trace-strict --profile strict
zlens agent trace validate ./ask-trace-strict
```

Compare two runs, for example before and after a fix:

```bash
zlens agent trace compare ./before ./after --mode compare
```

Command details: [Ask traces reference](../reference/ask-traces.md).
