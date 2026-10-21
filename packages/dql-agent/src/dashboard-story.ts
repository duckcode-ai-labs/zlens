import type {
  DashboardDisplayTrustState,
  DashboardStoryBrief,
  DashboardStoryClaim,
  DashboardStoryFact,
  ResultOrdering,
  ResultSourceHint,
} from '@zlens/core';
import { columnNameTokens, rankResultRows, resultLeaderRow, selectResultMeasures } from '@zlens/core';
import { computeResultStats } from './synthesize.js';

export interface DashboardStoryTileResult {
  tileId: string;
  title: string;
  status: string;
  trustState?: DashboardDisplayTrustState;
  grain?: string;
  result?: {
    columns?: unknown[];
    rows?: unknown[];
    rowCount?: number;
    columnsMeta?: Array<{ name?: unknown; kind?: unknown; unit?: unknown; decimals?: unknown; ref?: unknown }>;
  };
  /**
   * Result columns the tile's source declares as measures (a block's metric
   * mappings or output contract). Only measures are summed or reported as
   * what a row leads on; a rank, an id or a year never is.
   */
  declaredMeasures?: string[];
  /**
   * What produced the rows (the block's SQL, parameters and pattern), so a
   * top-N list is told from a whole population even with no rank column. The
   * tile title is always considered too ("Top 5 …").
   */
  source?: ResultSourceHint;
  /** A precomputed ordering for the tile's source (wins over `source`). */
  ordering?: ResultOrdering;
  /**
   * Dataset tiles declare whether their rows are a whole-scope scalar or
   * observations at a selected grain. This prevents the story generator from
   * reaggregating ratios, distinct counts, or a limited Top-N result.
   */
  datasetScope?: {
    kind: 'whole_scope' | 'grouped_observations';
    /**
     * The selected output aliases for grouped dimensions. These are a
     * presentation contract, so a time selection such as `order_date` at
     * month grain correctly resolves the returned `order_date_month` column.
     */
    outputDimensionAliases?: string[];
    dimensions: string[];
    limited?: boolean;
  };
  /** The actual dashboard controls that reached this tile's result. */
  filters?: Record<string, unknown>;
  citation?: { kind?: string; name?: string; path?: string };
}

export interface DashboardStoryBuildInput {
  goal: string;
  audience?: string;
  filters: Record<string, unknown>;
  /** Page filter labels by id, so the story names "Customer Name", not `customer_name`. */
  filterLabels?: Record<string, string>;
  tiles: DashboardStoryTileResult[];
  eligibleTileIds?: string[];
  driverTileIds?: string[];
}

export interface DashboardStoryBuildResult {
  facts: DashboardStoryFact[];
  story: DashboardStoryBrief;
}

const TRUST_ORDER: Record<DashboardDisplayTrustState, number> = {
  certified: 3,
  review_required: 2,
  draft_ready: 1,
};

export function buildDeterministicDashboardStory(input: DashboardStoryBuildInput): DashboardStoryBuildResult {
  const eligible = new Set(input.eligibleTileIds ?? input.tiles.map((tile) => tile.tileId));
  const drivers = new Set(input.driverTileIds ?? []);
  const facts: DashboardStoryFact[] = [];
  // How a ranked list's fact reads in prose: "**James Harden** leads with
  // **5,534** total points", not "… ranked first by total points is James
  // Harden: 5,534".
  const rankPhrases = new Map<string, string>();
  for (const tile of input.tiles) {
    if (!eligible.has(tile.tileId) || tile.status !== 'ok' || !tile.result) continue;
    // A pivot's total rows are totals, not members, and its flag columns are
    // not figures. Ranked by value, a total row would always read as the
    // clearest signal.
    const columns = (tile.result.columns ?? [])
      .map((column) => typeof column === 'string' ? column : String((column as { name?: unknown })?.name ?? column))
      .filter((column) => !column.startsWith('__total_'));
    const rows = (tile.result.rows ?? [])
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
      .filter((row) => !Object.entries(row).some(([column, value]) => column.startsWith('__total_') && Number(value) === 1));
    if (columns.length === 0 || rows.length === 0) continue;
    const stats = computeResultStats(columns, rows);
    const trustState = tile.trustState ?? 'review_required';
    const tileFilters = tile.filters ?? input.filters;
    const evidenceRef = tile.citation?.path ?? `${tile.citation?.kind ?? 'dashboard'}:${tile.citation?.name ?? tile.tileId}`;
    const first = rows[0] ?? {};
    // Measures only: a rank, an id, a year or a code is numeric and still a
    // label. Summing one ("rank is 15") or naming the row that maximizes it
    // ("leader is … : 5" for the fifth-ranked row) misreports the page.
    const selection = selectResultMeasures({
      columns,
      rows,
      columnsMeta: tile.result.columnsMeta,
      declaredMeasures: tile.declaredMeasures,
      source: { title: tile.title, ...(tile.source ?? {}) },
      ...(tile.ordering ? { ordering: tile.ordering } : {}),
    });
    const measureColumns = new Set(selection.measures);
    // A grouped query without ORDER BY returns its rows in a different order
    // on each run, so nothing below may read meaning into row position.
    const labelColumn = selection.labelColumn ?? columns.find((column) => rows.some((row) => typeof row[column] === 'string'));
    const numericStats = stats
      .filter((stat) => stat.kind === 'numeric' && measureColumns.has(stat.column))
      // The summary measure leads, then the others in result order.
      .sort((left, right) => Number(right.column === selection.primary) - Number(left.column === selection.primary));
    const columnMeta = new Map((tile.result.columnsMeta ?? [])
      .filter((meta): meta is { name: string; kind?: unknown; unit?: unknown; decimals?: unknown } => typeof meta?.name === 'string')
      .map((meta) => [meta.name, meta]));
    const observedGroups = tile.datasetScope?.kind === 'grouped_observations';
    if (observedGroups) {
      // A Dataset row at a declared dimension is evidence *at that dimension*.
      // Never turn rows such as monthly COUNT DISTINCT or ratio-of-sums into a
      // dashboard-wide total by summing display results. Keep the small set of
      // observations visibly group-qualified instead: the two largest values
      // of each measure, ties settled by group, and never a missing value.
      const declaredGroupColumn = resolveDeclaredGroupColumn(
        columns,
        tile.datasetScope?.outputDimensionAliases ?? tile.datasetScope?.dimensions ?? [],
      );
      const groupColumn = declaredGroupColumn ?? labelColumn;
      // A result its source orders (a rank column, ORDER BY … LIMIT, a top_n
      // parameter) is read in that order; any other is ranked by value.
      const sourceOrdered = Boolean(selection.rankColumn)
        || (selection.ordering?.kind === 'top_n' && ['rank_column', 'order_limit', 'top_n_parameter'].includes(selection.ordering.reason));
      for (const stat of numericStats.slice(0, 2)) {
        const unit = storyFormatUnit(columnMeta.get(stat.column));
        const observations = (sourceOrdered
          ? rows.map((row) => ({ row, value: numericValue(row[stat.column]) ?? null }))
          : rankResultRows(rows, {
            measure: (row) => numericValue(row[stat.column]),
            member: (row) => (groupColumn ? row[groupColumn] : undefined),
          })).filter((entry): entry is { row: Record<string, unknown>; value: number } => entry.value !== null).slice(0, 2);
        for (let index = 0; index < observations.length; index += 1) {
          const { row, value } = observations[index]!;
          const group = groupColumn && row[groupColumn] !== undefined
            ? formatGroupValue(row[groupColumn])
            : `ranked group ${index + 1}`;
          facts.push({
            id: `${tile.tileId}:observation:${stat.column}:${index + 1}`,
            tileId: tile.tileId,
            kind: drivers.has(tile.tileId) ? 'driver' : 'value',
            label: `${tile.title} — ${humanize(stat.column)} for ${group}`,
            value,
            unit,
            grain: tile.grain ?? `grouped by ${tile.datasetScope?.dimensions.map(humanize).join(', ') || 'Dataset dimension'}${tile.datasetScope?.limited ? ' (limited result)' : ''}`,
            filters: tileFilters,
            evidenceRef,
            trustState,
          });
        }
      }
      continue;
    }
    const unitOf = (column: string) => storyFormatUnit(columnMeta.get(column));
    const leader = resultLeaderRow({ rows }, selection);
    const leaderLabel = leader && labelColumn && leader[labelColumn] !== undefined && leader[labelColumn] !== null
      ? String(leader[labelColumn])
      : undefined;
    if (selection.ranked && rows.length > 1) {
      // A ranking or a top-N list (a rank column, or an ORDER BY … LIMIT, a
      // top_n parameter or a "Top N" title): the rows are a slice, not the
      // whole, so nothing is summed. Its story is who leads and on what.
      if (leaderLabel) {
        const leaderValue = selection.primary ? numericValue(leader![selection.primary]) : undefined;
        const formattedLeader = leaderValue !== undefined ? formatValue(leaderValue, unitOf(selection.primary!)) : undefined;
        const bottom = !selection.rankColumn && selection.ordering?.direction === 'asc';
        rankPhrases.set(`${tile.tileId}:rank:1`, formattedLeader !== undefined
          ? `${tile.title}: **${leaderLabel}** ${selection.rankColumn ? 'is ranked first, with' : bottom ? 'is lowest, with' : 'leads with'} **${formattedLeader}** ${humanize(selection.primary!)}`
          : `${tile.title}: **${leaderLabel}** is ranked first`);
        facts.push({
          id: `${tile.tileId}:rank:1`,
          tileId: tile.tileId,
          kind: 'rank',
          label: selection.primary
            ? `${tile.title} — ranked first by ${humanize(selection.primary)}`
            : `${tile.title} — ranked first`,
          value: leaderValue !== undefined
            ? `${leaderLabel}: ${formatValue(leaderValue, unitOf(selection.primary!))}`
            : leaderLabel,
          grain: tile.grain,
          filters: tileFilters,
          evidenceRef,
          trustState,
        });
      }
      continue;
    }
    // A limited slice (LIMIT without an order) is not the whole either.
    for (const stat of selection.limited && rows.length > 1 ? [] : numericStats.slice(0, 2)) {
      const singleValue = rows.length === 1 ? numericValue(first[stat.column]) : undefined;
      // A rate, an average or a share does not add up across rows.
      if (singleValue === undefined && isNonAdditiveMeasure(stat.column, columnMeta.get(stat.column))) continue;
      facts.push({
        id: `${tile.tileId}:value:${stat.column}`,
        tileId: tile.tileId,
        kind: drivers.has(tile.tileId) ? 'driver' : 'value',
        label: `${tile.title} — ${humanize(stat.column)}`,
        value: singleValue ?? stat.sum ?? null,
        unit: unitOf(stat.column),
        grain: tile.grain,
        filters: tileFilters,
        evidenceRef,
        trustState,
      });
    }
    if (rows.length > 1 && leaderLabel && selection.primary) {
      const leaderValue = numericValue(leader![selection.primary]);
      if (leaderValue !== undefined) {
        facts.push({
          id: `${tile.tileId}:rank:1`,
          tileId: tile.tileId,
          kind: 'rank',
          label: `${tile.title} leader by ${humanize(selection.primary)}`,
          value: `${leaderLabel}: ${formatValue(leaderValue, unitOf(selection.primary))}`,
          grain: tile.grain,
          filters: tileFilters,
          evidenceRef,
          trustState,
        });
      }
    }
  }
  // A selected page control can intentionally exclude a component. Preserve
  // that tile's complete-source fact, but never narrate it as if it carried
  // the global filter values used by other components.
  //
  // A page filter that reaches no tile at all is not part of any figure's
  // scope. Leave it out of the scope the story claims and name it in the caveat
  // instead, so "these figures use this exact filter scope" is only ever said
  // about filters that actually narrowed the narrated tiles (F6).
  const labelOf = (filterId: string) => input.filterLabels?.[filterId]?.trim() || humanize(filterId);
  // The filters with a value that actually narrowed a fact's tile.
  const activeScope = (filters: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(filters ?? {})
    .filter(([filterId, value]) => Object.prototype.hasOwnProperty.call(input.filters, filterId) && isActiveFilterValue(value)));
  const reachedFilterIds = new Set(facts.flatMap((fact) => Object.keys(activeScope(fact.filters))));
  const unreachedFilters = Object.entries(input.filters)
    .filter(([filterId, value]) => !reachedFilterIds.has(filterId) && isActiveFilterValue(value))
    .map(([filterId]) => labelOf(filterId));
  // Tiles narrowed by different filters are described separately, each with
  // the filters that reached it ("For Month …" and "For Customer Name …"),
  // instead of requiring every active filter to reach a tile before the story
  // may describe it. A tile no active filter reached is left out while any
  // filter is set, so an unfiltered figure is never told as a filtered one.
  const groups = new Map<string, { scope: Record<string, unknown>; facts: DashboardStoryFact[] }>();
  for (const fact of facts) {
    const scope = activeScope(fact.filters);
    const key = stableFilterKey(scope);
    const group = groups.get(key) ?? { scope, facts: [] };
    group.facts.push(fact);
    groups.set(key, group);
  }
  const narratedGroups = [...groups.values()]
    .filter((group) => reachedFilterIds.size === 0 || Object.keys(group.scope).length > 0)
    .sort((left, right) => Object.keys(right.scope).length - Object.keys(left.scope).length);
  const scopedFacts = narratedGroups.flatMap((group) => group.facts);
  const hasScopeExclusions = scopedFacts.length !== facts.length;
  const trustState = scopedFacts.reduce<DashboardDisplayTrustState>(
    (least, fact) => TRUST_ORDER[fact.trustState] < TRUST_ORDER[least] ? fact.trustState : least,
    'certified',
  );
  const scopeText = (scope: Record<string, unknown>) => {
    const named = filterScope(scope, labelOf);
    const missing = [...reachedFilterIds].filter((filterId) => !Object.prototype.hasOwnProperty.call(scope, filterId)).map(labelOf);
    return missing.length ? `${named} (not filtered by ${missing.join(', ')})` : named;
  };
  // The first three facts lead, the next three support, kept per scope.
  const take = (offset: number, count: number) => {
    const picked: Array<{ scope: Record<string, unknown>; facts: DashboardStoryFact[] }> = [];
    let index = 0;
    for (const group of narratedGroups) {
      const chosen = group.facts.filter(() => { index += 1; return index > offset && index <= offset + count; });
      if (chosen.length) picked.push({ scope: group.scope, facts: chosen });
    }
    return picked;
  };
  const primaryGroups = take(0, 3);
  const supportingGroups = take(3, 3);
  const primary = primaryGroups.flatMap((group) => group.facts);
  const supporting = supportingGroups.flatMap((group) => group.facts);
  const headline = primary.length
    ? `${humanize(input.goal).replace(/[?.!]+$/, '')}: the current picture`
    : `No result is available yet for ${humanize(input.goal).replace(/[?.!]+$/, '')}`;
  const primarySentences = primaryGroups.map((group) => `For ${scopeText(group.scope)}, the clearest ${group.facts.length === 1 ? 'signal is' : 'signals are'} ${joinFacts(group.facts, rankPhrases)}.`);
  const firstParagraph = primary.length
    ? primaryGroups.length === 1 && !scopeText(primaryGroups[0]!.scope).includes('(not filtered by')
      ? `For ${scopeText(primaryGroups[0]!.scope)}, the clearest signals are ${joinFacts(primary, rankPhrases)}. These figures come from tiles with this exact filter scope, so the summary and visible results stay aligned when filters change.`
      : `${primarySentences.join(' ')} Each figure is described with the filters that reached its tile.`
    : `The dashboard did not return enough governed evidence to summarize ${filterScope(activeScope(input.filters), labelOf)}. Apply a different filter range or review the unavailable sections before using this view for a decision.`;
  const driverFacts = scopedFacts.filter((fact) => fact.kind === 'driver');
  const supportingSentences = supportingGroups.map((group) => `${joinFacts(group.facts, rankPhrases)} add context across the rest of the view.`);
  const secondParagraph = supporting.length
    ? `${supportingSentences.join(' ')} ${driverFacts.length ? `The supported driver evidence points to ${joinFacts(driverFacts.slice(0, 2), rankPhrases)}.` : 'The current view shows association and ranking, but it does not prove why the pattern occurred.'}`
    : `The available evidence is concentrated in ${primary.length === 1 ? 'one business signal' : 'a small set of signals'}. Use Research deeper for a validated baseline or driver breakdown before describing the pattern as a cause.`;
  const claims: DashboardStoryClaim[] = [];
  // A claim never mixes facts with different filter scopes.
  if (primaryGroups.length === 1) claims.push({ text: firstParagraph, factIds: primary.map((fact) => fact.id), kind: 'observation' });
  else primaryGroups.forEach((group, index) => claims.push({ text: primarySentences[index]!, factIds: group.facts.map((fact) => fact.id), kind: 'observation' }));
  supportingGroups.forEach((group, index) => {
    const groupKey = stableFilterKey(group.scope);
    const groupDrivers = driverFacts.filter((fact) => stableFilterKey(activeScope(fact.filters)) === groupKey).slice(0, 2);
    claims.push({
      text: supportingGroups.length === 1 ? secondParagraph : supportingSentences[index]!,
      factIds: Array.from(new Set([...group.facts, ...groupDrivers].map((fact) => fact.id))),
      kind: groupDrivers.length ? 'driver' : 'observation',
    });
  });
  return {
    facts,
    story: {
      headline,
      paragraphs: [firstParagraph, secondParagraph],
      // "Verified" only when every fact comes from a certified source.
      implication: !scopedFacts.length
        ? undefined
        : trustState === 'certified'
          ? 'Use this view to focus the next decision on the strongest verified signal, then open the supporting evidence before acting.'
          : 'Use this view to focus the next question on the strongest signal, but its sources still need review: open the supporting evidence and confirm them before acting.',
      caveat: [
        driverFacts.length === 0 && scopedFacts.length > 0 ? 'This view does not contain validated causal evidence.' : undefined,
        hasScopeExclusions ? 'Some visible tiles are outside the current filter scope and are not included in this summary.' : undefined,
        facts.length > 0 && unreachedFilters.length > 0
          ? `${joinNames(unreachedFilters)} ${unreachedFilters.length === 1 ? 'does' : 'do'} not narrow any tile summarized here, so ${unreachedFilters.length === 1 ? 'it is' : 'they are'} not part of this summary's scope.`
          : undefined,
      ].filter((value): value is string => Boolean(value)).join(' ') || undefined,
      claims,
      evidenceRefs: Array.from(new Set(scopedFacts.map((fact) => fact.evidenceRef))),
      trustState: scopedFacts.length ? trustState : 'draft_ready',
      generatedBy: 'deterministic',
    },
  };
}

export function validateDashboardStoryBrief(
  story: DashboardStoryBrief,
  facts: DashboardStoryFact[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const allowedNumbers = new Set(facts.flatMap((fact) => [fact.value, fact.comparison?.baseline, fact.comparison?.delta, formatValue(fact.value, fact.unit)])
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => String(value).match(/-?\d+(?:\.\d+)?/g) ?? []));
  // Group-qualified Dataset observations may carry dates or identifiers in
  // their evidence-backed labels. Those tokens originate in the result row,
  // not generated prose, so permit them when the story repeats the label.
  for (const fact of facts) {
    for (const number of fact.label.match(/-?\d+(?:\.\d+)?/g) ?? []) allowedNumbers.add(number);
  }
  for (const value of facts.flatMap((fact) => Object.values(fact.filters ?? {}))) {
    // Filter values appear in prose as written and as formatted ("1 Jan 2025").
    const written = Array.isArray(value) ? value.join(' ') : value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    for (const number of `${written} ${formatFilterValue(value)}`.match(/-?\d+(?:\.\d+)?/g) ?? []) allowedNumbers.add(number);
  }
  const prose = [story.headline, ...story.paragraphs, story.implication ?? '', story.caveat ?? ''].join(' ');
  for (const number of prose.match(/-?\d+(?:\.\d+)?/g) ?? []) {
    if (!allowedNumbers.has(number)) errors.push(`unsupported number: ${number}`);
  }
  for (const claim of story.claims) {
    const evidence = claim.factIds.map((id) => byId.get(id)).filter((fact): fact is DashboardStoryFact => Boolean(fact));
    if (evidence.length !== claim.factIds.length || evidence.length === 0) errors.push(`claim has missing evidence: ${claim.text}`);
    if (claim.kind === 'comparison' && !evidence.some((fact) => fact.comparison)) errors.push(`comparison has no baseline: ${claim.text}`);
    if ((claim.kind === 'driver' || /\bcaused|driven by|because of|led to\b/i.test(claim.text)) && !evidence.some((fact) => fact.kind === 'driver')) {
      errors.push(`causal claim has no driver evidence: ${claim.text}`);
    }
    const grains = new Set(evidence.map((fact) => fact.grain).filter(Boolean));
    if (grains.size > 1) errors.push(`claim mixes incompatible grains: ${claim.text}`);
    const filterFingerprints = new Set(evidence.map((fact) => JSON.stringify(fact.filters ?? {})));
    if (filterFingerprints.size > 1) errors.push(`claim mixes incompatible filters: ${claim.text}`);
  }
  return { ok: errors.length === 0, errors };
}

function joinFacts(facts: DashboardStoryFact[], phrases?: ReadonlyMap<string, string>): string {
  return facts
    .map((fact) => phrases?.get(fact.id) ?? `${fact.label} is **${formatValue(fact.value, fact.unit)}**`)
    .join(facts.length > 2 ? '; ' : ' and ');
}

/** An empty multi-select is "All", not a filter; so is a date range with neither end. */
function isActiveFilterValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return false;
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>);
    const rangeKeys = ['start', 'end', 'from', 'to', 'min', 'max'];
    if (entries.every(([key]) => rangeKeys.includes(key))) {
      return entries.some(([, end]) => end !== undefined && end !== null && end !== '');
    }
  }
  return true;
}

function stableFilterKey(filters: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)));
}

function joinNames(names: string[]): string {
  const capitalized = names.map((name, index) => (index === 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name));
  if (capitalized.length <= 1) return capitalized.join('');
  return `${capitalized.slice(0, -1).join(', ')} and ${capitalized[capitalized.length - 1]}`;
}

function filterScope(filters: Record<string, unknown>, labelOf: (filterId: string) => string = humanize): string {
  const active = Object.entries(filters).filter(([, value]) => isActiveFilterValue(value));
  if (active.length === 0) return 'the current scope';
  return active.map(([key, value]) => `${labelOf(key)} ${formatFilterValue(value)}`).join(', ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2025-03-01` reads "1 Mar 2025"; anything else as written. */
function formatFilterDate(value: unknown): string {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return text;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : text;
}

/**
 * A filter value as a person reads it: a date range "1 Jan 2025 – 30 Jun
 * 2025" (or "from 1 Mar 2025" / "until 30 Jun 2025"), a list "CA, NY", a
 * single value as written. Never "[object Object]".
 */
export function formatFilterValue(value: unknown): string {
  if (value instanceof Date) return formatFilterDate(value);
  if (Array.isArray(value)) {
    const dates = value.length === 2 && value.every((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}/.test(entry));
    return dates ? `${formatFilterDate(value[0])} – ${formatFilterDate(value[1])}` : value.map((entry) => formatFilterValue(entry)).join(', ');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const has = (entry: unknown) => entry !== undefined && entry !== null && entry !== '';
    const start = record.start ?? record.from ?? record.min;
    const end = record.end ?? record.to ?? record.max;
    if (has(start) || has(end)) {
      if (has(start) && has(end)) return `${formatFilterDate(start)} – ${formatFilterDate(end)}`;
      return has(start) ? `from ${formatFilterDate(start)}` : `until ${formatFilterDate(end)}`;
    }
    return Object.entries(record).filter(([, entry]) => has(entry)).map(([key, entry]) => `${humanize(key)} ${formatFilterValue(entry)}`).join(', ');
  }
  return String(value);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Measures whose row values cannot be summed into a page figure. */
function isNonAdditiveMeasure(column: string, meta: { kind?: unknown } | undefined): boolean {
  if (meta?.kind === 'percent') return true;
  const tokens = columnNameTokens(column);
  return tokens.some((token) => ['avg', 'average', 'mean', 'median', 'rate', 'ratio', 'pct', 'percent', 'percentage', 'share', 'per'].includes(token));
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

function resolveDeclaredGroupColumn(columns: string[], aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const normalizedAlias = normalizeOutputAlias(alias);
    const column = columns.find((candidate) => normalizeOutputAlias(candidate) === normalizedAlias);
    if (column) return column;
  }
  return undefined;
}

function normalizeOutputAlias(value: string): string {
  return value.trim().toLowerCase();
}

function formatGroupValue(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // A time-grain result represents a calendar bucket. Use the unambiguous
    // date portion rather than the process-local rendering of a Date object.
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}

function storyFormatUnit(meta: { kind?: unknown; unit?: unknown; decimals?: unknown } | undefined): string | undefined {
  if (!meta || typeof meta.kind !== 'string') return undefined;
  const decimals = typeof meta.decimals === 'number' && Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 12
    ? meta.decimals
    : undefined;
  if (meta.kind === 'percent') return `percent${decimals === undefined ? '' : `:${decimals}`}`;
  if (meta.kind === 'currency') {
    const currency = typeof meta.unit === 'string' && /^[A-Z]{3}$/.test(meta.unit) ? meta.unit : 'USD';
    return `currency:${currency}${decimals === undefined ? '' : `:${decimals}`}`;
  }
  return decimals === undefined ? undefined : `number:${decimals}`;
}

function formatValue(value: unknown, unit?: string): string {
  if (typeof value === 'number') {
    const [kind, configuredUnit, configuredDecimals] = (unit ?? '').split(':');
    const parsedDecimals = configuredDecimals === undefined ? undefined : Number(configuredDecimals);
    const fractionDigits = typeof parsedDecimals === 'number'
      && Number.isInteger(parsedDecimals)
      && parsedDecimals >= 0
      && parsedDecimals <= 12
      ? parsedDecimals
      : undefined;
    if (kind === 'percent') {
      const percentDigits = Number.isInteger(Number(configuredUnit)) ? Number(configuredUnit) : fractionDigits;
      return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: percentDigits ?? 0, maximumFractionDigits: percentDigits ?? 2 }).format(value);
    }
    if (kind === 'currency' && configuredUnit && /^[A-Z]{3}$/.test(configuredUnit)) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: configuredUnit, minimumFractionDigits: fractionDigits ?? 2, maximumFractionDigits: fractionDigits ?? 2 }).format(value);
    }
    if (kind === 'number') {
      const numberDigits = Number.isInteger(Number(configuredUnit)) ? Number(configuredUnit) : fractionDigits;
      if (numberDigits !== undefined) {
        return new Intl.NumberFormat('en-US', { minimumFractionDigits: numberDigits, maximumFractionDigits: numberDigits }).format(value);
      }
    }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  }
  return String(value ?? 'not available');
}
