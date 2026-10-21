# Import SQL

Turn SQL you already have into draft blocks. ZLens reads the SQL, drafts a
block for each query and runs a preview. You review each draft, save the ones
you want to keep, and certify the ones that are right.

{{ clip("import-certify") }}

## 1. Open Import SQL

1. In the left rail, click **Blocks**.
2. With no block open, Block Studio shows **Create DQL blocks**. On the
   **Import SQL** card, click **Start import**.

The page is titled **Import SQL to DQL** and shows three steps: **Source**,
**Draft** and **Review**.

## 2. Give it your SQL

Pick one:

- **Paste SQL**: paste one or more queries.
- **Upload files**: pick `.sql` files.
- **Local path**: a file or folder inside your project.

Optionally set **Domain** and **Owner**. Then click **Generate DQL drafts**.

ZLens works through **Reading SQL** and **Running previews**, then **Import
complete**. Nothing is written to your project yet: a draft becomes a block
file only when you click **Save draft** on it.

## 3. Review each draft

The **Drafts** list shows one row per query. Click a draft to see:

- **Review details**: name, domain, owner, description, grain, outputs and
  other fields you can edit.
- **Preview Results**: the rows the query returned.
- **Original SQL** and **Draft DQL block**: before and after.

Click **Show context (N)** to see the **Grounding**: the tables and columns
ZLens matched, with any warnings. **Hide context** closes it again.

Edit the review details if something is wrong. **Edit full DQL** opens the
whole block. If ZLens finds a similar certified block, the save button reads
**Reuse existing** and is disabled, and there is no **Certify**: use the
existing block instead of saving a copy.

## 4. Save the draft

Click **Save draft**. This is when the block file and its companion YAML are
written. The message reads **Draft saved · needs review. Certify it when it is
ready.**

- A draft needs an **Owner**.
- If you changed the review details, ZLens saves the values you see.
- If the name is taken, rename the draft and save again.

## 5. Certify it

Click **Certify**. It is available once the draft is saved.

ZLens runs the block and its tests, if it has any (tests are optional). When
the checks pass, the block moves out of `_drafts/` to its normal place and is
**Certified**, with a receipt that says `via: sql-import`. When they do not,
you see **Not certified; the draft is unchanged.** and the reasons. See
[Save and certify](certify.md) for the rules.

## Where the drafts go

Saved drafts go in:

- `domains/<domain>/blocks/_drafts/` when your project has domain folders,
  otherwise `blocks/_drafts/<domain>/`.
- The import session is cached in `.dql/imports/<session>/`. **Import
  history** lists past sessions.

## From the terminal

Unlike the Import SQL page, the terminal command saves every draft as it goes.

```bash
zlens import sql ./legacy-sql --domain finance --owner you@example.com
```

It prints one line per query with the draft's path, and ends with:

```text
Drafts are autosaved under blocks/_drafts or domains/<domain>/blocks/_drafts. Review, preview, then certify selected candidates.
```

Then certify a draft with
`zlens certify --from-draft <path> --owner you@example.com`.
