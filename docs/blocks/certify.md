# Save and certify

ZLens keeps two steps apart:

- **Save** keeps your work. The block is a **draft**.
- **Certify** is a person saying "this is right". ZLens runs its checks, and
  only if they pass does the block become **Certified**, with a record of who
  certified it.

**Saving never certifies.** Not in Block Studio, not in Import SQL, not when
Ask keeps a draft, and not from the CLI.

## Save a draft

In Block Studio, click **Save draft**.

- A block needs a name and an **Owner** before it can be saved.
- The block is written with `status = "draft"`.
- If the block was already certified, your edit is saved as a separate draft
  beside it. Block Studio says **Saved as a draft beside the certified block.
  The certified version stays in use until this draft is certified.**

## Certify a block

1. Open the block in Block Studio.
2. Click **Certify** in the toolbar (**Re-certify** on a block that is already
   certified).

ZLens saves your latest edits, then checks the block. The certification panel,
in the **Metadata** tab at the bottom, shows each check: **Metadata**,
**Validation**, **Run**, **Tests**, **Chart · optional** and **Lineage ·
optional**.

**When it passes**, the panel reads **Block certified**, the badge changes to
**CERTIFIED**, and a receipt line appears under the block name on the block's
overview (the only place Block Studio shows it):

```text
Certified by you@example.com · 10/15/2026, 3:27:48 PM · via Block Studio · OSS rules
```

**When it does not pass**, the panel reads **Unable to certify** and lists
**Fixes before certification**. Each fix says how to fix it and has a button
for it, such as **Run block** or **Edit source**. Your draft stays saved and
nothing is half-certified.

### Other places that certify

Block Studio's **Certify** is not the only one. These run the same rules and
write the same receipt:

| Where | Action | Receipt says |
|---|---|---|
| [Import SQL](import-sql.md) | **Certify** on a saved draft | `via: sql-import` |
| App Studio, a Dataset from a table | **Certify and use this data** | `via: app-dataset` |
| Terminal | `zlens certify --from-draft <path>` | `via: cli` |

## The rules

To be certified, a block must:

- have an **Owner**,
- compile and run successfully, and
- pass every test it declares.

Tests are optional: a block with no tests can be certified, and the receipt
records the missing tests as a warning. `--enterprise` rules require at least
one test.

A description that still says "review required" also blocks certification.
Block Studio offers to remove those words or let you edit the description.

Other checks are warnings: an AI-facing description (LLM context), tests,
grain, declared outputs, entities and a review cadence. They are recorded on
the receipt. With `zlens certify --enterprise`, they become requirements.

## Add tests

Tests are assertions about the block's result. Certify runs them; running the
block does not. In the block's DQL:

```dql
tests {
  assert row_count > 0
  assert revenue >= 0
  assert region IN ["east", "west", "north"]
}
```

- `row_count` compares the number of rows.
- A column test (`assert revenue >= 0`) must hold on **every row**. The first
  row that breaks it is reported, with how many rows fail.
- `IN [ … ]` holds when every row's value is one of the listed values.
- `==`, `!=` and `IN` compare numbers as numbers and other values as text.
  `>`, `>=`, `<` and `<=` need numbers; an empty or text value fails them.
- A column test on an empty result passes. Add `assert row_count > 0` when the
  block must return rows.

In the visual builder, use the **Tests** box. If a test fails, Certify stops
with **A block test failed**. `zlens certify` and `zlens test` check tests the
same way.

## Where the receipt is kept

Each block has a companion YAML file under `semantic-layer/blocks/`. When you
certify, ZLens writes:

```yaml
reviewStatus: certified
certification:
  certifiedBy: you@example.com
  certifiedAt: '2026-10-15T20:27:48.466Z'
  via: block-studio
  rules: oss
  sourceSha256: b8e2…
  checks:
    - metadata
    - validation
    - run
    - tests
  warnings:
    - 'Block has LLM context: No llmContext set — agents will fall back to description/SQL'
```

- `sourceSha256` is a fingerprint of the block source that was certified.
- `checks` lists the checks that passed, and `warnings` the advisory warnings
  (missing tests, LLM context, grain, …). Either is left out when empty.
- **Certified by** is the person signed in when a hosted server runs ZLens.
  Locally it is `identity.owner` in `dql.config.json`; when that is not set,
  your git email (`git config user.email`), then your computer's user name.

## Edited after certification

A certified block stays certified only while its source is the one that was
certified. If someone edits the `.dql` file outside ZLens (in an editor, a
merge or a script) and leaves `status = "certified"`, the source no longer
matches the receipt's `sourceSha256`, and ZLens treats the block as needing
recertification:

- Block Studio shows the **RECERTIFY** badge and says **Edited after it was
  certified**.
- Ask, Apps and AI agents do not use it as certified evidence.
- `zlens compile` lists the block as `pending_recertification`, and `zlens
  verify` and `zlens certify <file>` print a warning.

To clear it, open the block, check the change, and click **Re-certify**. A new
receipt is written for the edited source.

A block certified before ZLens wrote receipts has no `sourceSha256` to compare
with, so it stays certified. Editing a certified block in Block Studio never
needs this check: saving an edit writes a draft beside the certified block.

## What Ask shows

When Ask answers from a certified block, the answer is labelled **Certified
answer**, and the line under it reads **from** *block name* **· Owner:**
*owner*.

## Certify from the terminal

Check a block without changing it:

```bash
zlens certify blocks/finance/revenue-by-segment.dql
```

It runs the block's tests on the project's connection and prints
`Status: ✓ CERTIFIABLE` or `Status: ✗ NOT CERTIFIABLE` with the reasons. It
exits with code 1 when the block does not pass, and writes nothing. The rules
are the same as Block Studio's: tests are optional (a block without tests
gets a warning), and `--enterprise` requires at least one.

!!! note
    A DuckDB file can be opened by one program at a time. When `zlens
    notebook` is running for the project, the terminal commands run the block
    through it, so you do not need to stop it.

Certify a draft:

```bash
zlens certify --from-draft blocks/_drafts/top-customers.dql --owner you@example.com
```

When the checks pass, it moves the draft to its normal place, sets it to
certified, writes the receipt (with `via: cli`), and prints
`✓ Promoted <draft> -> <path>.` Then run `zlens compile` to refresh
`dql-manifest.json`. When the checks fail, the draft is unchanged.

## Retire a block

1. Open a certified block and the **Metadata** tab at the bottom.
2. Click **Deprecate**. It takes effect at once; there is no confirmation.

Only certified blocks have **Deprecate**.

Deprecating keeps the block's certification receipt in its companion YAML and
records the deprecation beside it:

```yaml
reviewStatus: deprecated
certification:
  certifiedBy: you@example.com
  certifiedAt: '2026-10-15T20:27:48.466Z'
  via: block-studio
  rules: oss
  sourceSha256: b8e2…
deprecation:
  deprecatedBy: you@example.com
  deprecatedAt: '2026-10-21T09:12:03.120Z'
  via: block-studio
  previousStatus: certified
```

The receipt is kept as history: with `reviewStatus: deprecated`, Ask, Apps
and Block Studio no longer treat the block as certified. **Deprecated by** is
found the same way as **Certified by**. Moving the block back to **draft**
removes both records.

To send people to a newer block, set `replacedBy` in the block. Block Studio
then shows **Replaced by** with **Open the replacement →**.
