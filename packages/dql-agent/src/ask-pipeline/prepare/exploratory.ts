import type { AnalyticalIntentV1 } from '../intent.js';
import { sqlAnswerArtifact } from './dql-artifacts.js';
import type { VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal } from './types.js';

/**
 * THE LAST TIER: SQL drafted from the schema and the reading when no governed
 * tier could prepare the intent. It is review-required, never governed: the
 * host drafts it with the provider over the relations and columns the
 * vocabulary admits, validates it against the catalog (only admitted
 * relations, no internal names), and this tier additionally proves it is one
 * read-only statement. Every execution control still applies afterwards —
 * the filter-literal and window proofs, the row cap, the connection's
 * read-only executor. What it never does is widen access: a policy denial
 * ends the turn before this tier is reached.
 */

const READ_ONLY_START = /^\s*(with|select)\b/i;
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|merge|grant|revoke|truncate|call|copy|put|remove|use|set|begin|commit|rollback|execute|exec)\b/i;

/** One read-only statement: starts with SELECT or WITH, carries no data-changing keyword, and is not several statements. */
export function readOnlyStatementProblem(sql: string): string | undefined {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (!READ_ONLY_START.test(text)) return 'the statement does not start with SELECT or WITH';
  if (/;/.test(text.replace(/'(?:[^']|'')*'/g, ''))) return 'more than one statement';
  const forbidden = FORBIDDEN.exec(text.replace(/'(?:[^']|'')*'/g, ''));
  if (forbidden) return `the statement uses ${forbidden[1]!.toUpperCase()}`;
  return undefined;
}

const HOLDS = String.raw`(?:holds?|contains?|has|have|stores?|records?|includes?|tracks?|captures?|provides?|describes?|carr(?:y|ies))`;
const LISTED = String.raw`(?:listed|provided|given|available|supplied|described|above|inspected|these|those)`;
const TABLES = String.raw`(?:relations?|tables?|schemas?|columns?|fields?|data ?sets?)`;
/** "No column in the listed relations holds payroll/employee expense data". */
const NO_COLUMN_HOLDS = new RegExp(String.raw`^(?:there (?:is|are) )?no (?:${TABLES})(?: or (?:${TABLES}))? (?:in|among|across|of|from) (?:the |any of the |any )?(?:${LISTED} )?${TABLES}(?: (?:listed|provided|given|above))? ${HOLDS} (?:any )?(.+)$`, 'i');
/** "None of the listed tables contain payroll data", "The provided relations do not include payroll". */
const NONE_HOLDS = new RegExp(String.raw`^(?:none of the|the) (?:${LISTED} )?${TABLES}(?: (?:listed|provided|given|above))? (?:(?:do|does) not |don't |doesn't )?${HOLDS} (?:any )?(.+)$`, 'i');
/** What the host adds after a decline: how far Ask looked. */
const LOOKED = /\s*\((Ask looked through (every table it can read|the tables it chose), and no other table has a column for it|Ask also looked in the tables that have a column named for it)\)\s*$/;

/**
 * A DECLINE IN PLAIN WORDS. The drafter says why no SQL answers the question in its own terms: "No column in the
 * listed relations holds payroll/employee expense data" (V2, listing retake F9). A reader is told the same thing
 * in theirs: "None of the tables Ask can read has payroll or employee expense data". A sentence these patterns do
 * not know keeps its words, with "relations" said as tables.
 */
export function plainDeclineReason(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  const looked = LOOKED.exec(text);
  const core = (looked ? text.slice(0, looked.index) : text).replace(/[.\s]+$/, '');
  const everyTable = !looked || Boolean(looked[2]?.startsWith('every'));
  const which = everyTable ? 'the tables Ask can read' : 'the tables Ask searched';
  const said = (words: string) => words.replace(/(?<=[A-Za-z])\/(?=[A-Za-z])/g, ' or ').replace(/[.\s]+$/, '');
  // Only a sentence in the drafter's terms is said again: one that already reads plainly keeps its words.
  const technical = /\b(?:relations?|columns?|fields?|listed|provided|schemas?|inspected)\b/i.test(core);
  const missing = !technical ? undefined : NO_COLUMN_HOLDS.exec(core)?.[1] ?? (/^(?:none of the|the) /i.test(core) ? NONE_HOLDS.exec(core)?.[1] : undefined);
  if (missing && !/\b(?:but|because|since|although|however)\b/i.test(missing)) {
    const sentence = `None of ${which} has ${said(missing)}`;
    // "Every table it can read" is what the sentence already says.
    return looked && !everyTable ? `${sentence} (${looked[1]})` : sentence;
  }
  const plain = said(core)
    .replace(new RegExp(String.raw`\b(?:the |any of the )?${LISTED} (?:relations|tables|schemas?)\b`, 'gi'), which)
    .replace(/\brelations\b/gi, 'tables')
    .replace(/\brelation\b/gi, 'table');
  return looked ? `${plain} (${looked[1]})` : plain;
}

export async function prepareExploratory(
  intent: AnalyticalIntentV1 | undefined,
  vocabulary: VocabularyIndex,
  deps: PrepareDeps,
  question: string,
  context: { reason?: string; previous?: { sql: string; error: string }; /** The earlier question a follow-up with no reading continues. */ followUp?: string } = {},
): Promise<{ candidates: PreparedCandidate[]; refusals: PreparedRefusal[] }> {
  // A derived/offset/cumulative dbt metric is an engine-owned definition. The
  // semantic tier runs first; this lane is reached only when it did not answer
  // (no layer loaded, a compile error, a field it does not hold). The draft
  // then rebuilds the metric from its authored definition, exactly, or
  // declines, and the answer is review-required and says so.
  const metricRefs = (intent?.measures ?? []).flatMap((measure) => measure.change
    ? []
    : measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]);
  const engineOwned = metricRefs
    .map((ref) => vocabulary.get(ref))
    .filter((entry) => Boolean(entry?.engineOnly));
  const engineNote = engineOwned.length > 0
    ? `${[...new Set(engineOwned.map((entry) => entry!.label ?? entry!.name))].join(', ')} ${engineOwned.length === 1 ? 'is an authored semantic metric' : 'are authored semantic metrics'} (${[...new Set(engineOwned.map((entry) => entry!.engineOnly))].join('; ')}) that the semantic engine did not run here: rebuild ${engineOwned.length === 1 ? 'it' : 'them'} exactly from the definition in CONTEXT, and reply NO_SQL when the listed tables cannot express that definition`
    : undefined;
  // An engine's message can carry a local file path (where a manifest was
  // looked for); a path on this machine never goes to the AI provider, and a
  // prompt that changes with a temp folder is not the same question twice.
  const withoutPaths = (text: string | undefined) => text?.replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:[\w.@+~-]+(?:\/|\\))+[\w.@+~-]*/g, '<path>');
  const reason = [withoutPaths(context.reason), engineNote].filter(Boolean).join('; ') || undefined;
  if (!deps.draftSql) {
    return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_unavailable', message: 'no SQL drafting provider is configured for review-required exploration', repairable: false }] };
  }
  let drafted: Awaited<ReturnType<NonNullable<PrepareDeps['draftSql']>>>;
  try {
    drafted = await deps.draftSql({ question, ...(intent ? { intent } : {}), vocabulary, ...(reason ? { reason } : {}), ...(context.previous ? { previous: context.previous } : {}), ...(context.followUp ? { followUp: context.followUp } : {}) });
  } catch (error) {
    return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_failed', message: `the SQL draft failed: ${error instanceof Error ? error.message : String(error)}`, repairable: false }] };
  }
  // The drafter looked at the tables and found nothing that answers the
  // question: an honest "not in this data", never a substitute measure.
  if (drafted && 'declined' in drafted) {
    return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_declined', message: plainDeclineReason(drafted.declined), repairable: false }] };
  }
  // The statement was drafted and failed a check it was given one chance to
  // fix (a stated value or a required filter left out): nothing runs.
  if (drafted && 'refused' in drafted) {
    return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_check_failed', message: drafted.refused, repairable: false }] };
  }
  if (drafted && 'error' in drafted && drafted.unavailable) {
    return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_tables_unavailable', message: drafted.error, repairable: false }] };
  }
  if (!drafted || 'error' in drafted) {
    return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_failed', message: drafted?.error ?? 'the provider returned no SQL', repairable: false }] };
  }
  const sql = drafted.sql.replace(/^```(?:sql)?\s*/i, '').replace(/```\s*$/, '').trim().replace(/;\s*$/, '');
  const problem = readOnlyStatementProblem(sql);
  if (problem) return { candidates: [], refusals: [{ tier: 'exploratory', code: 'exploration_not_read_only', message: `the drafted SQL is not one read-only statement (${problem}); nothing was executed`, repairable: false }] };
  return {
    candidates: [{
      tier: 'exploratory', trust: 'review_required', sql,
      artifact: sqlAnswerArtifact(sql, intent?.reading ?? question),
      ...(drafted.relations.length ? { relations: drafted.relations } : {}),
      proof: [
        `AI-drafted SQL over ${drafted.relations.length ? drafted.relations.join(', ') : 'the admitted relations'}: no certified block and no governed metric or composition answered this reading, so the statement was written from the schema and the reading, validated against the catalog (only admitted relations and columns, one read-only statement) and is review-required — read it before you rely on it`,
        ...drafted.proof,
        ...(context.reason ? [`why no governed answer: ${context.reason.slice(0, 300)}`] : []),
        ...(context.previous ? ['redrafted once after the warehouse rejected the first statement'] : []),
      ],
      ...(drafted.engine ? { engine: drafted.engine } : {}),
    }],
    refusals: [],
  };
}
