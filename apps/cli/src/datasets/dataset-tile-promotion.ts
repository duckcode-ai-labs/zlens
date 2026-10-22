import { createHash } from 'node:crypto';

import type { DatasetTileProvenanceV1, TileQuery } from '@zlens/core';

export type DatasetTilePromotionRefusalCode =
  | 'comparison_not_representable_as_single_block'
  | 'dataset_tile_not_settled'
  | 'dataset_tile_sql_unavailable'
  | 'dataset_tile_not_single_statement'
  | 'dataset_tile_dynamic_binding_not_representable';

export type DatasetTilePromotionPlan =
  | {
    ok: true;
    source: string;
    provenance: DatasetTileProvenanceV1;
    /** Replacement remains an explicit separate action and may be unavailable. */
    replacementEligible: boolean;
    replacementMessage?: string;
  }
  | { ok: false; code: DatasetTilePromotionRefusalCode; message: string };

export interface DatasetTilePromotionInput {
  appId: string;
  pageId: string;
  tileId: string;
  name: string;
  domain: string;
  description?: string;
  datasetId: string;
  sourceRevision: string;
  contractFingerprint: string;
  query: TileQuery;
  queryFingerprint: string;
  filterFingerprint: string;
  parameterFingerprint: string;
  interactionFingerprint: string;
  snapshotFingerprint: string;
  targetFingerprint: string;
  personaPolicyFingerprint: string;
  receiptId: string;
  sql: string;
  schemaFingerprint: string;
  resultFingerprint: string;
  /** Server-derived from the settled tile result, never inferred from rows. */
  complete?: boolean;
  /** A cache-delivery receipt cannot become reusable-block or equivalence authority. */
  cacheDelivery?: boolean;
  /** Server-derived, never a browser assertion. */
  futureBindingsRepresentable: boolean;
  /**
   * The exact values bound to the executed statement's positional
   * placeholders (`$1`, `$2`, …), server-held from the settled run. The saved
   * block declares each as a typed `params { }` default so it runs on its own
   * and returns the same result.
   */
  boundParameters: DatasetTileBoundParameter[];
  now?: () => Date;
}

export interface DatasetTileBoundParameter {
  position: number;
  /** Source block parameter name, or a generated dataset tile filter name. */
  name: string;
  value: unknown;
}

/**
 * Produce one review-draft block body from an already settled physical Dataset
 * result. This is deliberately a planner only: callers still reload all
 * current App/source/receipt authority and use the existing atomic writer.
 */
export function planDatasetTilePromotion(input: DatasetTilePromotionInput): DatasetTilePromotionPlan {
  if (input.query.comparison) {
    return refusal('comparison_not_representable_as_single_block', 'This comparison uses multiple executions and result graph arithmetic, so it cannot be saved as one reusable saved query. The Dataset tile remains runnable.');
  }
  if (input.cacheDelivery) {
    return refusal('dataset_tile_not_settled', 'Cached delivery is not fresh execution authority. Refresh this tile before saving it as a reusable saved query.');
  }
  if (input.complete !== true) {
    return refusal('dataset_tile_not_settled', 'This Dataset result is not a complete current tile result. Run a complete current tile before saving it as a reusable saved query.');
  }
  const required = [
    input.appId, input.pageId, input.tileId, input.name, input.domain, input.datasetId,
    input.sourceRevision, input.contractFingerprint, input.queryFingerprint, input.filterFingerprint,
    input.parameterFingerprint, input.interactionFingerprint, input.snapshotFingerprint,
    input.targetFingerprint, input.personaPolicyFingerprint, input.receiptId, input.schemaFingerprint,
    input.resultFingerprint,
  ];
  if (required.some((value) => !value.trim())) {
    return refusal('dataset_tile_not_settled', 'This tile has no complete current App Dataset receipt. Run the current tile again before saving it.');
  }
  const sql = input.sql.trim();
  if (!sql) return refusal('dataset_tile_sql_unavailable', 'This Dataset execution did not return one reusable physical SQL statement.');
  if (!isOneSqlStatement(sql)) {
    return refusal('dataset_tile_not_single_statement', 'This Dataset execution requires more than one SQL statement or unsupported dynamic SQL, so ZLens will not save it as a reusable saved query.');
  }
  if (sql.includes('"""')) {
    return refusal('dataset_tile_sql_unavailable', 'The executed SQL cannot be represented safely in a saved query.');
  }
  const parameterized = parameterizeExecutedSql(sql, input.boundParameters);
  if (!parameterized.ok) return refusal('dataset_tile_dynamic_binding_not_representable', parameterized.message);
  const provenance: DatasetTileProvenanceV1 = {
    version: 1,
    kind: 'dataset_tile_provenance',
    appId: input.appId,
    pageId: input.pageId,
    tileId: input.tileId,
    datasetId: input.datasetId,
    sourceRevision: input.sourceRevision,
    contractFingerprint: input.contractFingerprint,
    query: input.query,
    queryFingerprint: input.queryFingerprint,
    filterFingerprint: input.filterFingerprint,
    parameterFingerprint: input.parameterFingerprint,
    interactionFingerprint: input.interactionFingerprint,
    snapshotFingerprint: input.snapshotFingerprint,
    targetFingerprint: input.targetFingerprint,
    personaPolicyFingerprint: input.personaPolicyFingerprint,
    receiptId: input.receiptId,
    sqlFingerprint: fingerprint(sql),
    schemaFingerprint: input.schemaFingerprint,
    resultFingerprint: input.resultFingerprint,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const source = [
    `block ${JSON.stringify(input.name.trim())} {`,
    `  domain = ${JSON.stringify(input.domain.trim())}`,
    '  type = "custom"',
    '  status = "draft"',
    ...(input.description?.trim() ? [`  description = ${JSON.stringify(input.description.trim())}`] : []),
    `  dataset_tile_provenance = ${JSON.stringify(JSON.stringify(provenance))}`,
    ...(parameterized.params.length ? [
      '  params {',
      ...parameterized.params.map((param) => `    ${param.name}: ${param.type} = ${param.literal}`),
      '  }',
    ] : []),
    '  query = """',
    ...parameterized.sql.split('\n').map((line) => `    ${line}`),
    '  """',
    '}',
    '',
  ].join('\n');
  return {
    ok: true,
    source,
    provenance,
    replacementEligible: input.futureBindingsRepresentable,
    ...(input.futureBindingsRepresentable
      ? {}
      : { replacementMessage: 'Saved as a fixed-value review draft. Replacement is unavailable because this tile has bindings or interactions that the current saved query contract cannot represent.' }),
  };
}

type ParameterizedSql =
  | { ok: true; sql: string; params: Array<{ name: string; type: 'string' | 'number' | 'boolean'; literal: string }> }
  | { ok: false; message: string };

/**
 * The executed statement binds every filter value positionally. A block binds
 * `${name}` references the same way (the compiler lowers each to a positional
 * parameter), so each `$N` becomes a named reference whose default is the
 * value that produced the settled result. Placeholders inside quoted text or
 * comments are left alone; a placeholder without a recorded value, a `?`
 * placeholder, or a value that is not a scalar refuses the save instead of
 * writing a block that cannot run or would run differently.
 */
function parameterizeExecutedSql(sql: string, bound: DatasetTileBoundParameter[]): ParameterizedSql {
  const byPosition = new Map(bound.map((parameter) => [parameter.position, parameter]));
  const names = new Map<number, string>();
  const used = new Set<string>();
  const params: Array<{ name: string; type: 'string' | 'number' | 'boolean'; literal: string }> = [];
  let out = '';
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      out += current;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        out += '*/';
        index += 1;
        continue;
      }
      out += current;
      continue;
    }
    if (quote) {
      if (current === quote && sql[index - 1] !== '\\') quote = undefined;
      out += current;
      continue;
    }
    if (current === '-' && next === '-') { lineComment = true; out += '--'; index += 1; continue; }
    if (current === '/' && next === '*') { blockComment = true; out += '/*'; index += 1; continue; }
    if (current === "'" || current === '"' || current === '`') { quote = current; out += current; continue; }
    if (current === '?') {
      return { ok: false, message: 'The executed SQL uses an anonymous parameter that a saved query cannot name. The Dataset tile remains unchanged.' };
    }
    if (current === '$' && next !== undefined && /[0-9]/.test(next)) {
      let end = index + 1;
      while (end < sql.length && /[0-9]/.test(sql[end]!)) end += 1;
      const position = Number(sql.slice(index + 1, end));
      let name = names.get(position);
      if (!name) {
        const parameter = byPosition.get(position);
        if (!parameter || !Object.prototype.hasOwnProperty.call(parameter, 'value')) {
          return { ok: false, message: `The executed SQL has no recorded value for parameter $${position}. Run the current tile again before saving it.` };
        }
        const literal = paramLiteral(parameter.value);
        if (!literal) {
          return { ok: false, message: `Parameter $${position} holds a value a saved query cannot declare as a default. The Dataset tile remains unchanged.` };
        }
        const base = /^[A-Za-z][A-Za-z0-9_]*$/.test(parameter.name) && !parameter.name.startsWith('__') ? parameter.name : `tile_param_${position}`;
        name = base;
        for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
        used.add(name);
        names.set(position, name);
        params.push({ name, ...literal });
      }
      out += '${' + name + '}';
      index = end - 1;
      continue;
    }
    out += current;
  }
  return { ok: true, sql: out, params };
}

function paramLiteral(value: unknown): { type: 'string' | 'number' | 'boolean'; literal: string } | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', literal: String(value) } : undefined;
  if (typeof value === 'boolean') return { type: 'boolean', literal: String(value) };
  if (typeof value === 'string') {
    // The DQL lexer understands \n, \t, \\ and quote escapes only.
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) return undefined;
    return { type: 'string', literal: JSON.stringify(value) };
  }
  return undefined;
}

function refusal(code: DatasetTilePromotionRefusalCode, message: string): DatasetTilePromotionPlan {
  return { ok: false, code, message };
}

/** Reject a second executable statement without attempting to parse user SQL. */
function isOneSqlStatement(sql: string): boolean {
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let semicolonAt = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === quote && sql[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (current === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current;
      continue;
    }
    if (current === ';') {
      if (semicolonAt >= 0) return false;
      semicolonAt = index;
    }
  }
  return !quote && !blockComment && (semicolonAt < 0 || sql.slice(semicolonAt + 1).trim() === '');
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
