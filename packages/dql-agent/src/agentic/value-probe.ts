/**
 * `search_values` — bind a literal the user named to a real column value.
 *
 * The recorded highest-severity defect in this program: asking about a specific
 * member returned every row instead of that member's, and the narration then
 * described the truncated result as if the member were absent. The chain was
 * `runtime_value_index` empty -> no member grounding -> empty filters -> plan
 * froze filterless -> 200 of 500 rows -> "no such customer".
 *
 * The persisted index was deleted for a good reason (SEC-003: warehouse cell
 * values must not sit in a rebuildable metadata database). The fix is not to
 * bring it back but to look the value up ON DEMAND, bounded, and only in columns
 * a project has agreed may be searched.
 *
 * Two independent gates, and BOTH must pass:
 *   1. a hard deny-list that no configuration can override — secrets and
 *      free-text payloads are never probed, however a project is set up
 *   2. an allow-list of column-name shapes that plausibly hold an identifier
 *
 * The deny-list is first and unconditional on purpose. An allow-list alone
 * eventually admits something it should not, because it grows by exception.
 */
import type { AgentToolDefinition } from '../providers/types.js';
import { parsePhysicalIdentifier } from '@zlens/core';

export interface ProbeColumn {
  name: string;
  type?: string;
}

export interface ProbeRelation {
  relation: string;
  columns: ProbeColumn[];
}

/** Values that must never be probed, whatever the configuration says. */
/**
 * Hard deny. No configuration overrides this.
 *
 * Three groups, and the reason each is here:
 *   SECRETS — a probe returns literal values, so one match leaks the secret.
 *   FREE TEXT — a note or description can contain anything, including all of
 *     the above, so its shape gives no safety.
 *   DIRECT AND REGULATED IDENTIFIERS — payment, government, contact, health,
 *     and compensation fields. A probe over these is a data-protection
 *     incident even when the query is otherwise correct, and "the model asked
 *     for it" is not a defence. Added after a live run answered a request for
 *     credit-card numbers and home addresses from the nearest certified block.
 *
 * Deliberately broad. A false deny costs one value lookup; a false allow
 * cannot be undone once the values have left the warehouse.
 */
const DENY_RE = /\b(password|passwd|secret|token|credential|apikey|api key|private key|hash|salt|signature|session|cookie|auth|otp|pin)\b|\b(notes?|comments?|description|message|body|payload|content|remarks?|feedback|reason)\b|\b(ssn|social security|social insurance|sin\b|dob|date of birth|birth date|birthdate|national id|government id|government identifier|tax id|taxpayer id|taxpayer identification|tin\b|itin\b|ein\b|medicare|medicaid|passport|license|licence|driver license|visa|nric|aadhaar)\b|\b(card|cardnumber|card number|credit card|debit card|cvv|cvc|iban|swift|bic|routing|account number|acct|sort code|bank)\b|\b(address|street|postal|postcode|zip|zipcode|latitude|longitude|geo|coordinates?)\b|\b(phone|mobile|telephone|fax|contact number)\b|\b(salary|compensation|wage|payroll|bonus|income|net pay|gross pay)\b|\b(medical|diagnosis|patient|health|insurance|prescription|disability|biometric|fingerprint|race|ethnicity|religion|gender|sexual)\b/;
/** Email is denied separately: it is an identifier, but also direct PII. */
const EMAIL_RE = /\bemail\b/;

/** Name shapes that plausibly identify an entity rather than describe one. */
const IDENTIFIER_TOKENS = new Set([
  'account', 'category', 'channel', 'city', 'code', 'country', 'customer',
  'full', 'id', 'key', 'member', 'name', 'number', 'product', 'region',
  'segment', 'sku', 'state', 'status', 'subscriber', 'tier', 'type', 'user',
]);

/**
 * Token-level aliases that must remain denied even when a connector exposes
 * them with underscores, dashes, or camel case rather than the prose phrases
 * above.  The phrase regex is intentionally broad, but `tax_number` and
 * `customerBirthDt` never contain the literal phrase "tax id" or "birth
 * date".  Normalise the identifier into tokens before the allow-list gets a
 * chance to treat its `number` / `customer` part as a business key.
 */
const SENSITIVE_IDENTIFIER_PREFIXES = new Set([
  'government', 'govt', 'national', 'tax', 'taxpayer',
]);
const SENSITIVE_IDENTIFIER_SUFFIXES = new Set([
  'id', 'identifier', 'number', 'no', 'num',
]);
// Connector metadata often elides separators inside an otherwise ordinary
// entity identifier (for example `customer_taxnumber`). Match only a
// sensitive alias at the end of the compact identifier: this catches the
// sensitive suffix without turning `customer_id` or `product_number` into a
// false positive.
const COMPACT_SENSITIVE_IDENTIFIER_ALIAS_RE = /(?:taxpayer|tax|government|govt|national)(?:id|identifier|number|no|num)$/;
const COMPACT_BIRTH_DATE_ALIAS_RE = /(?:birth(?:date|dt|day|dob|on)|dateofbirth|birthday)$/;

/** Types that can hold a searchable literal. */
const TEXTUAL_TYPE_RE = /\b(char|character|clob|string|text|uuid|varchar|nvarchar)\b/;

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-.]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
}

function isSensitiveIdentifierAlias(tokens: ReadonlySet<string>): boolean {
  const has = (...values: string[]) => values.some((value) => tokens.has(value));
  const compact = [...tokens].join('');
  if (COMPACT_SENSITIVE_IDENTIFIER_ALIAS_RE.test(compact) || COMPACT_BIRTH_DATE_ALIAS_RE.test(compact)) {
    return true;
  }
  // `date_of_birth`, `customer_birth_dt`, and `customerDOB` are all direct
  // personal identifiers despite their otherwise identifier-shaped names.
  if (has('dob') || (has('birth') && has('date', 'dt', 'day', 'on'))) return true;
  // Treat a government/tax qualifier plus an identifier suffix as sensitive.
  // This intentionally does not deny ordinary business identifiers such as
  // `customer_id`, `product_number`, or `order_code`.
  return has(...SENSITIVE_IDENTIFIER_PREFIXES)
    && has(...SENSITIVE_IDENTIFIER_SUFFIXES);
}

/**
 * May this column be probed for a literal?
 *
 * Canonical implementation — the host's `isAgentValueProbeColumn` delegates here
 * so the deny-list has exactly one definition. Two copies of a security rule
 * drift, and the one that drifts is the one nobody is looking at.
 */
export function isProbeSafeColumn(column: ProbeColumn): boolean {
  const normalized = column.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase();
  if (DENY_RE.test(normalized)) return false;
  if (EMAIL_RE.test(normalized)) return false;
  const tokens = tokenize(column.name);
  if (isSensitiveIdentifierAlias(tokens)) return false;
  if (![...tokens].some((token) => IDENTIFIER_TOKENS.has(token))) return false;
  const type = column.type?.toLowerCase() ?? '';
  // An unknown type is allowed: many drivers omit it, and the name gates already
  // passed. A KNOWN non-textual type is not — a literal cannot live in a float.
  if (!type) return true;
  return TEXTUAL_TYPE_RE.test(type);
}

/** Escape a single-quoted SQL literal. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote an identifier ANSI-style, rejecting anything that is not a plain name. */
function quoteIdentifier(value: string): string | undefined {
  // Identifiers come from the SCHEMA, never from the user, so anything exotic
  // here means a caller is passing something it should not.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) return undefined;
  return `"${value}"`;
}

function quoteRelation(relation: string): string | undefined {
  const parts = parsePhysicalIdentifier(relation).map((part) => quoteIdentifier(part.value));
  return parts.every(Boolean) ? parts.join('.') : undefined;
}

/**
 * Build a bounded DISTINCT lookup for one column.
 *
 * Exact match first, then a prefix match on the longer tokens. Prefix rather
 * than `%term%`: a leading wildcard cannot use an index, and on a large
 * dimension table that is the difference between a probe and an outage.
 */
export function buildValueProbeSql(relation: string, column: string, terms: readonly string[], limit = 25): string | undefined {
  const quotedRelation = quoteRelation(relation);
  const quotedColumn = quoteIdentifier(column);
  if (!quotedRelation || !quotedColumn) return undefined;
  const cast = `LOWER(CAST(${quotedColumn} AS VARCHAR))`;
  const predicates: string[] = [];
  for (const term of terms) {
    const normalized = term.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    predicates.push(`${cast} = ${sqlLiteral(normalized)}`);
    for (const token of normalized.split(' ').filter((part) => part.length >= 4).slice(0, 2)) {
      predicates.push(`${cast} LIKE ${sqlLiteral(`${token.replace(/[%_\\]/g, '\\$&')}%`)} ESCAPE '\\'`);
    }
  }
  if (predicates.length === 0) return undefined;
  return [
    `SELECT DISTINCT CAST(${quotedColumn} AS VARCHAR) AS value`,
    `FROM ${quotedRelation}`,
    `WHERE ${quotedColumn} IS NOT NULL AND (${[...new Set(predicates)].slice(0, 8).join(' OR ')})`,
    `LIMIT ${Math.max(1, Math.min(limit, 50))}`,
  ].join('\n');
}

export interface SearchValuesOptions {
  execute: (sql: string) => Promise<{ rows: unknown[] }>;
  relations: readonly ProbeRelation[];
  /** Probing is opt-in per project; disabled means the tool reports why. */
  enabled: boolean;
  /** Max relations probed per call, so one question cannot scan the warehouse. */
  maxRelations?: number;
  /** Hard ceiling across columns, not per relation. Never expose more than this many queries. */
  maxColumnQueries?: number;
}

export type ValueProbeCoverageStatus = 'complete' | 'partial' | 'disabled' | 'budget_exhausted' | 'unknown_relation';

/**
 * Redacted coverage is the evidence contract for a value lookup.  It says what
 * was attempted without leaking query text, warehouse errors, or values that
 * were not already supplied by the caller.
 */
export interface ValueProbeCoverageV1 {
  version: 1;
  status: ValueProbeCoverageStatus;
  queryLimit: number;
  queriesAttempted: number;
  relationsRequested: string[];
  relationsSearched: string[];
  relationsWithNoSearchableColumn: string[];
  /** Approved relation/column identifiers that could not form ANSI probe SQL. */
  relationsWithUnbuildableIdentifier: string[];
  failedRelations: string[];
  unknownRelations: string[];
}

/** The total maximum value-probe queries a single tool call may issue. */
export const MAX_VALUE_PROBE_COLUMN_QUERIES = 12;

/**
 * A tool that answers "does this literal exist, and in which column?".
 *
 * Returns the matched VALUES — which is the point, since the loop needs the
 * exact stored spelling to build a filter — but only from columns that passed
 * both gates, and only values the caller already named.
 */
export function buildSearchValuesTool(options: SearchValuesOptions): AgentToolDefinition {
  const maxRelations = options.maxRelations ?? 6;
  const maxColumnQueries = Math.max(1, Math.min(options.maxColumnQueries ?? MAX_VALUE_PROBE_COLUMN_QUERIES, MAX_VALUE_PROBE_COLUMN_QUERIES));
  return {
    name: 'search_values',
    description:
      'Check whether a literal the question names (a customer, product, region, status) exists as a value in the data, and get its exact stored spelling. Use it BEFORE filtering on a name, so a filter is built from a real value rather than a guess. Only searches columns approved for value lookup.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['terms'],
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: 'Literals named in the question, e.g. ["Wesley Jenkins"].' },
        relations: { type: 'array', items: { type: 'string' }, description: 'Optional relations to restrict the search to.' },
      },
    },
    run: async (args: unknown) => {
      const input = (args && typeof args === 'object' ? args : {}) as { terms?: unknown; relations?: unknown };
      const terms = Array.isArray(input.terms)
        ? input.terms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
        : [];
      if (terms.length === 0) return { error: 'Pass the literal(s) to look up, e.g. ["Wesley Jenkins"].' };
      if (!options.enabled) {
        // Say WHY, and name the setting. A silent empty result here is what
        // produced the false-absence defect: the loop concluded the value did
        // not exist when it had simply never been allowed to look.
        return {
          searched: false,
          reason: 'Value lookup is disabled for this project. Enable agent.runtimeValueGrounding in dql.config.json to let DQL confirm a named value before filtering on it.',
          matches: [],
          coverage: {
            version: 1,
            status: 'disabled',
            queryLimit: maxColumnQueries,
            queriesAttempted: 0,
            relationsRequested: [],
            relationsSearched: [],
            relationsWithNoSearchableColumn: [],
            relationsWithUnbuildableIdentifier: [],
            failedRelations: [],
            unknownRelations: [],
          } satisfies ValueProbeCoverageV1,
        };
      }
      const requestedRelations = Array.isArray(input.relations)
        ? [...new Set(input.relations.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim()))]
        : [];
      const wanted = requestedRelations.length > 0
        ? new Set(requestedRelations.map((relation) => relation.toLowerCase()))
        : undefined;
      const knownRelations = new Set(options.relations.map((relation) => relation.relation.toLowerCase()));
      const unknownRelations = requestedRelations.filter((relation) => !knownRelations.has(relation.toLowerCase()));
      const matches: Array<{ relation: string; column: string; values: string[] }> = [];
      const searched: string[] = [];
      const skipped: string[] = [];
      const unbuildableRelations = new Set<string>();
      const failedRelations = new Set<string>();
      let queriesAttempted = 0;
      let relationBudgetExceeded = false;
      let queryBudgetExceeded = false;
      let relationsConsidered = 0;
      for (const relation of options.relations) {
        if (wanted && !wanted.has(relation.relation.toLowerCase())) continue;
        if (relationsConsidered >= maxRelations) {
          relationBudgetExceeded = true;
          break;
        }
        relationsConsidered += 1;
        const safe = relation.columns.filter(isProbeSafeColumn);
        if (safe.length === 0) { skipped.push(relation.relation); continue; }
        for (const column of safe) {
          if (queriesAttempted >= maxColumnQueries) {
            queryBudgetExceeded = true;
            break;
          }
          const sql = buildValueProbeSql(relation.relation, column.name, terms);
          if (!sql) {
            // Metadata identifiers are not automatically executable SQL
            // identifiers.  Never turn an unquotable schema name into a
            // zero-query "not found" claim.
            unbuildableRelations.add(relation.relation);
            continue;
          }
          if (!searched.includes(relation.relation)) searched.push(relation.relation);
          queriesAttempted += 1;
          try {
            const result = await options.execute(sql);
            const values = (result.rows ?? [])
              .map((row) => (Array.isArray(row) ? row[0] : (row as Record<string, unknown>)?.value))
              .filter((value): value is string => typeof value === 'string');
            if (values.length > 0) matches.push({ relation: relation.relation, column: column.name, values });
          } catch {
            // One unreadable relation must not fail the whole probe; a permission
            // error on a single table is normal in a governed warehouse.
            failedRelations.add(relation.relation);
          }
        }
        if (queryBudgetExceeded) break;
      }
      const complete = unknownRelations.length === 0
        && failedRelations.size === 0
        && skipped.length === 0
        && unbuildableRelations.size === 0
        && !relationBudgetExceeded
        && !queryBudgetExceeded;
      const status: ValueProbeCoverageStatus = unknownRelations.length > 0
        ? 'unknown_relation'
        : queryBudgetExceeded || relationBudgetExceeded
          ? 'budget_exhausted'
          : complete
            ? 'complete'
            : 'partial';
      const coverage: ValueProbeCoverageV1 = {
        version: 1,
        status,
        queryLimit: maxColumnQueries,
        queriesAttempted,
        relationsRequested: requestedRelations,
        relationsSearched: searched,
        relationsWithNoSearchableColumn: skipped,
        relationsWithUnbuildableIdentifier: [...unbuildableRelations],
        failedRelations: [...failedRelations],
        unknownRelations,
      };
      return {
        searched: searched.length > 0,
        terms,
        matches,
        relationsSearched: searched,
        ...(skipped.length > 0 ? { relationsWithNoSearchableColumn: skipped } : {}),
        coverage,
        // Absence is a claim, not a default for an empty array.  Only an
        // exhaustive, error-free scan of the approved scope may support it.
        ...(matches.length === 0 && complete
          ? { absence: 'not_found', note: 'Searched the approved columns and found no match for these literals.' }
          : {}),
      };
    },
  };
}
