/**
 * Certified-block adaptation lane (W2.2).
 *
 * When a certified block is CLOSE to answering but the question adds exactly ONE
 * small delta — most commonly "the same certified breakdown, but just the <value>
 * row" — regenerating from scratch throws away governed logic. Instead we adapt the
 * certified SQL with a single, mechanically-safe transform and serve it at a trust
 * tier BELOW certified (base `reviewed`, qualifier "adapted from certified block X")
 * — never `certified`, because the adapted query itself was not human-reviewed.
 *
 * v1 handles the add-filter delta via an OUTPUT subquery wrapper:
 *   SELECT * FROM ( <certified sql> ) AS certified_derived WHERE <col> = <value>
 * This is provably safe (it only RESTRICTS rows of the already-certified result)
 * and dialect-neutral, and is valid exactly when the filter column is one of the
 * block's OUTPUT columns (a dimension the certified block already groups by). If
 * the filter would need to reach INPUT rows and re-aggregate, the column is not in
 * the outputs and we return null → the caller falls through to generation.
 *
 * Adding a GROUP-BY dimension (re-graining the inner query) is intentionally NOT
 * attempted in v1 — it cannot be done as a safe output wrapper.
 */
import { analyzeSqlReferences } from '@zlens/core';
import type { CertifiedBlockFit } from './block-fit.js';

export interface CertifiedAdaptation {
  /** The adapted SQL to execute. */
  sql: string;
  /** Trust qualifier composed onto the base `reviewed` label. */
  trustQualifier: string;
  /** Human-facing provenance line naming the donor block and the transform. */
  provenance: string;
}

function quoteAdaptValue(value: string): string {
  return /^-?\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : `'${value.replace(/'/g, "''")}'`;
}

function normalizeColumn(name: string): string {
  return name.replace(/["`]/g, '').trim().toLowerCase();
}

/**
 * Adapt a certified block's SQL by filtering its OUTPUT to a single column=value.
 * Returns null when the filter column is not one of `outputColumns` (so the wrapper
 * would reference a non-existent column) or when inputs are blank.
 */
export function adaptCertifiedSqlWithFilter(input: {
  certifiedSql: string;
  filterColumn: string;
  filterValue: string;
  outputColumns: string[];
  blockName: string;
}): CertifiedAdaptation | null {
  const certifiedSql = input.certifiedSql?.trim();
  const filterColumn = input.filterColumn?.trim();
  const filterValue = input.filterValue?.trim();
  if (!certifiedSql || !filterColumn || !filterValue) return null;

  // The filter column MUST be an output of the certified query, else the wrapper
  // references a column that does not exist in the subquery result.
  const outputs = new Set(input.outputColumns.map(normalizeColumn));
  if (!outputs.has(normalizeColumn(filterColumn))) return null;

  // The certified SQL must be a single parseable read-only SELECT/WITH so wrapping
  // it in a subquery is safe.
  const analysis = analyzeSqlReferences(certifiedSql);
  if (!analysis.parsed) return null;
  const stripped = certifiedSql.replace(/;\s*$/, '');
  const sql = `SELECT * FROM (\n${stripped}\n) AS certified_derived\nWHERE ${filterColumn} = ${quoteAdaptValue(filterValue)}`;

  return {
    sql,
    trustQualifier: `adapted from certified saved query ${input.blockName}`,
    provenance:
      `Derived from certified saved query "${input.blockName}" by filtering its result to ` +
      `${filterColumn} = ${quoteAdaptValue(filterValue)}. Not itself certified — review before stakeholder reuse.`,
  };
}

/**
 * Decide whether a context-only certified block can be safely adapted to answer the
 * question with exactly ONE added filter. Returns the adaptation, or null when the
 * block is not a single-delta fit (extra dimensions/outputs/grain mismatch, more
 * than one filter), or the filter value does not resolve to exactly one block-output
 * column. Null ⇒ the caller falls through to generation.
 */
export function planCertifiedAdaptation(input: {
  blockFit: CertifiedBlockFit;
  certifiedSql: string;
  blockName: string;
  blockOutputs: string[];
  /** Resolve a filter VALUE (e.g. "food") to the physical column(s) that carry it. */
  resolveFilterColumn: (value: string) => string[];
}): CertifiedAdaptation | null {
  const fit = input.blockFit;
  // The ONLY delta may be a single unsupported filter — nothing else missing.
  if (fit.kind !== 'context_only') return null;
  if (fit.missingDimensions.length > 0 || fit.missingOutputs.length > 0 || fit.grainMismatch) return null;
  if (fit.unsupportedFilters.length !== 1) return null;

  const filterValue = fit.unsupportedFilters[0];
  const outputs = new Set(input.blockOutputs.map((column) => normalizeColumn(column)));
  const columns = input.resolveFilterColumn(filterValue).filter((column) => outputs.has(normalizeColumn(column)));
  // Exactly one block-output column must carry the value; ambiguous or input-only ⇒ fall through.
  if (columns.length !== 1) return null;

  return adaptCertifiedSqlWithFilter({
    certifiedSql: input.certifiedSql,
    filterColumn: columns[0],
    filterValue,
    outputColumns: input.blockOutputs,
    blockName: input.blockName,
  });
}
