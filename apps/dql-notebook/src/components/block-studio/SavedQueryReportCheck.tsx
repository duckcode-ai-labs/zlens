import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import type { ReportQueryMatch, ReportVerdict } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { ReportComparePanel } from './ReportComparePanel';

/**
 * The old report check on a saved query's own page: its last comparison, and
 * the box to compare it again. Certifying puts the result on the receipt.
 *
 * One rule for a certified query (V14): its receipt states what was true when
 * it was certified ("Old report when certified: …"); a comparison made after
 * that shows beside it ("Old report since certified: …"), and a Differs after
 * certification puts a short warning next to the Certified badge.
 *
 * What was true when it was certified is the last comparison made before it,
 * whichever file it was with (V2 retest; report-match/status.ts,
 * queryStandingRecord). One comparison reads the same on the result, the page
 * and the receipt: a Differs counts the values that differ.
 */

/** How a receipt line about an old report starts (report-match/record.ts, matchWords and receiptMatchWords). */
const MATCH_LINE = /^(Matches |Differs from |Not proven against )/;
const UNREADABLE_LINE = /comparison with the old report can't be read/;

/**
 * A receipt's old report lines, apart from its other checks: a current match is
 * a passed check; anything else about the old report is a warning.
 */
export function reportMatchReceipt(certification: { checks?: string[]; warnings?: string[] } | undefined): { checks: string[]; matched: string[]; warnings: string[] } {
  const checks = certification?.checks ?? [];
  return {
    checks: checks.filter((line) => !MATCH_LINE.test(line)),
    matched: checks.filter((line) => MATCH_LINE.test(line)),
    warnings: (certification?.warnings ?? []).filter((line) => MATCH_LINE.test(line) || UNREADABLE_LINE.test(line)),
  };
}

const verdictColor = (verdict: ReportVerdict, t: Theme) => (verdict === 'matches' ? 'var(--status-success)' : verdict === 'differs' ? 'var(--status-warning)' : t.accent);

/** What the page says before the box: the last comparison, or that there is none. */
export function reportCheckStatusWords(status: ReportQueryMatch | null, certified = false): string {
  if (!status) return '';
  if (status.unreadable) return status.unreadable;
  if (!status.match) {
    return certified
      ? 'Not compared with an old report yet. Compare it with an export of the report it replaces: every value is checked. Its receipt keeps what was true when it was certified; the result shows beside it.'
      : 'Not compared with an old report yet. Compare it with an export of the report it replaces: every value is checked, and certifying records the result on its receipt.';
  }
  return `Last compared: ${wordsOnViewerClock(status.match.words, status.match.comparedAt)}.`;
}

/**
 * A saved query's standing comparison with an old report, by its name; `reload` after a new one is recorded. With
 * its file, also what its receipt names when that receipt was written under the earlier rule (atCertification).
 */
export function useQueryReportMatch(name: string | undefined, path?: string | null): { status: ReportQueryMatch | null; reload: () => void } {
  const [status, setStatus] = useState<ReportQueryMatch | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!name) {
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    void api.getQueryReportMatch(name, path ?? undefined)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [name, path, version]);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { status, reload };
}

/** The comparison made after the query was certified, if the standing one is that recent. */
export function comparedSinceCertified(certifiedAt: string | undefined, status: ReportQueryMatch | null): NonNullable<ReportQueryMatch['match']> | null {
  const match = status?.match;
  if (!match || !certifiedAt) return null;
  const compared = Date.parse(match.comparedAt);
  const certified = Date.parse(certifiedAt);
  if (!Number.isFinite(compared) || !Number.isFinite(certified)) return null;
  return compared > certified ? match : null;
}

export const DIFFERS_SINCE_CERTIFIED = 'Differs from the old report since it was certified';

/** A comparison made after certification, as the receipt and the badge beside Certified say it. */
export type ComparedSince = { verdict: ReportVerdict; words: string };

/** What a certified query's receipt says about the old report: then (at certification) and since (a later comparison). */
export interface CertificationReportView {
  /** The receipt's lines about the old report recorded at certification, each a passed check or a warning. */
  then: Array<{ line: string; matched: boolean }>;
  /** Nothing about an old report was on record when it was certified, but it was compared since. */
  notCompared: boolean;
  since: ComparedSince | null;
  /** The receipt file names another comparison, written under the earlier rule: `then` is the one in effect. */
  rebuilt?: { replaces: string[] };
}

/** The day a receipt line says its comparison was made: "Differs from X, 2026-11-12: …" or "(5 of 5 at …, 2026-11-11)". */
export function receiptLineDay(line: string): string | undefined {
  return /, (\d{4}-\d{2}-\d{2})(?=[:)])/.exec(line)?.[1];
}

/** A moment's calendar day on the viewer's clock. */
function viewerDay(moment: number): string {
  const date = new Date(moment);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The latest calendar day a moment falls on, on the server's clock (UTC in the app for Snowflake) or the viewer's. */
function latestDayOf(moment: number): string {
  const local = viewerDay(moment);
  const utc = new Date(moment).toISOString().slice(0, 10);
  return local > utc ? local : utc;
}

/**
 * A comparison's words with its day on the viewer's clock, like the "Certified · 11 Nov" beside it. The server
 * writes the day on its own clock (UTC in the app for Snowflake): a comparison made at 10:30 PM on 11 Nov in
 * California read "2026-11-12" next to a certification of 11 Nov (V14 retest).
 */
export function wordsOnViewerClock(words: string, comparedAt: string): string {
  const day = receiptLineDay(words);
  const moment = Date.parse(comparedAt);
  if (!day || !Number.isFinite(moment)) return words;
  const local = viewerDay(moment);
  return local === day ? words : words.replace(new RegExp(`, ${day}(?=[:)])`), `, ${local}`);
}

const verdictOfLine = (line: string): ReportVerdict => (line.startsWith('Matches ') ? 'matches' : line.startsWith('Differs from ') ? 'differs' : 'not-proven');

/** How a receipt said a Differs or a Not proven before V2: the count of equal values, straight after the day. */
const OLD_COUNT = /^((?:Differs from |Not proven against ).*, \d{4}-\d{2}-\d{2}: )(\d+) of (\d+) values at /;

/**
 * A receipt line in today's words. Before V2 a Differs counted the equal values ("Differs from X, 2026-11-11:
 * 4 of 5 values at whole numbers"), which read as 4 values differing beside a result that said 1 (V2 retest). Such
 * a line says the values that differ ("1 of 5 values differs"), as the result and the record do; any other line
 * is shown as written.
 */
export function receiptLineWords(line: string): string {
  const found = OLD_COUNT.exec(line);
  if (!found) return line;
  const [whole, head, equalText, comparedText] = found as unknown as [string, string, string, string];
  const equal = Number(equalText);
  const compared = Number(comparedText);
  const differing = compared - equal;
  const counted = head.startsWith('Differs from ') && differing > 0
    ? `${differing} of ${compared} values ${differing === 1 ? 'differs' : 'differ'}`
    : `${equal} of ${compared} values equal`;
  return `${head}${counted} at ${line.slice(whole.length)}`;
}

/**
 * One rule for what the receipt says (V2 on top of V14): a comparison made after the query was certified is never
 * shown as "when certified". The standing comparison's own time decides when its line is on the receipt; any other
 * line counts as later only when its day is after the certification's day on every clock. With nothing on record
 * at certification and a comparison since, the receipt says "not compared" then, the later one since, and a later
 * Differs puts the warning next to Certified.
 */
export function certificationReportView(
  certification: { certifiedAt?: string; checks?: string[]; warnings?: string[] } | undefined,
  status: ReportQueryMatch | null,
): CertificationReportView {
  const receipt = reportMatchReceipt(certification);
  // A receipt written under the earlier rule names the worst comparison per file, not the one in effect when it
  // was certified (V2 retest, 11 Nov): the server rebuilt its line from the records, as certifying writes it now.
  const rebuilt = certification && status?.atCertification?.replaces.length ? status.atCertification : undefined;
  const replaced = new Set(rebuilt?.replaces ?? []);
  const matched = [...receipt.matched.filter((line) => !replaced.has(line)), ...(rebuilt?.checks ?? [])];
  const warnings = [...receipt.warnings.filter((line) => !replaced.has(line)), ...(rebuilt?.warnings ?? [])].map(receiptLineWords);
  const certifiedAt = certification?.certifiedAt ? Date.parse(certification.certifiedAt) : Number.NaN;
  const standing = status?.match ?? null;
  // The standing comparison's own line on the receipt (a warning may add ". Changed since compared.").
  const isStanding = (line: string) => Boolean(standing && (line === standing.words || line.startsWith(`${standing.words}.`)));
  const madeLater = (line: string): boolean => {
    if (!Number.isFinite(certifiedAt)) return false;
    if (standing && isStanding(line)) {
      const compared = Date.parse(standing.comparedAt);
      if (Number.isFinite(compared)) return compared > certifiedAt;
    }
    const day = receiptLineDay(line);
    return Boolean(day && day > latestDayOf(certifiedAt));
  };
  const shown = (line: string) => (standing && isStanding(line) ? wordsOnViewerClock(line, standing.comparedAt) : line);
  const lines = [...matched.map((line) => ({ line, matched: true })), ...warnings.map((line) => ({ line, matched: false }))];
  const then = lines.filter((item) => !madeLater(item.line)).map((item) => ({ ...item, line: shown(item.line) }));
  const later = lines.filter((item) => madeLater(item.line));
  const exact = certification ? comparedSinceCertified(certification.certifiedAt, status) : null;
  const since: ComparedSince | null = exact
    ? { verdict: exact.verdict, words: wordsOnViewerClock(exact.words, exact.comparedAt) }
    : later[0] ? { verdict: verdictOfLine(later[0].line), words: shown(later[0].line) } : null;
  return { then, notCompared: Boolean(since) && then.length === 0, since, ...(rebuilt ? { rebuilt: { replaces: rebuilt.replaces } } : {}) };
}

/** Under a rebuilt line: the receipt file is left as written, and Re-certify writes the line on it. */
export const RECEIPT_REBUILT_NOTE = 'Its receipt file names an earlier comparison. Re-certify to write this one on it.';

/** The receipt's lines about the old report: then (at certification), and since (a later comparison). */
export function CertificationReportLines({ view, t }: { view: CertificationReportView; t: Theme }) {
  return (
    <>
      {view.notCompared ? (
        <div data-testid="block-certification-report-not-compared">Old report when certified: not compared</div>
      ) : null}
      {view.then.map(({ line, matched }) => (
        matched
          ? <div key={line} data-testid="block-certification-report-match" style={{ color: 'var(--status-success)' }}>Old report when certified: {line}</div>
          : <div key={line} data-testid="block-certification-report-warning" style={{ color: 'var(--status-warning)' }}>Old report when certified: {line}</div>
      ))}
      {view.rebuilt && view.then.length ? (
        <div data-testid="block-certification-report-rebuilt" title={`The receipt file says: ${view.rebuilt.replaces.map(receiptLineWords).join('; ')}`} style={{ color: t.textMuted }}>{RECEIPT_REBUILT_NOTE}</div>
      ) : null}
      {view.since ? (
        <div data-testid="block-certification-report-since" style={{ color: verdictColor(view.since.verdict, t) }}>Old report since certified: {view.since.words}</div>
      ) : null}
    </>
  );
}

/** Beside the Certified badge, when a comparison after certification differs. */
export function DiffersSinceCertifiedBadge({ since }: { since: ComparedSince | null }) {
  if (since?.verdict !== 'differs') return null;
  return (
    <span
      data-testid="block-certification-differs-since"
      role="status"
      title={`${since.words}. The receipt keeps what was true when it was certified.`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 650, color: 'var(--status-warning)', border: '1px solid var(--status-warning-border)', background: 'var(--status-warning-bg)', borderRadius: 999, padding: '1px 8px' }}
    >
      <AlertTriangle size={11} aria-hidden="true" /> {DIFFERS_SINCE_CERTIFIED}
    </span>
  );
}

export function SavedQueryReportCheck({ name, path, certified = false, status, onRecorded, primaryButton, t }: {
  name: string;
  path?: string;
  /** Already certified: the box says its result shows beside the receipt, not on it. */
  certified?: boolean;
  status: ReportQueryMatch | null;
  onRecorded: () => void;
  primaryButton: CSSProperties;
  t: Theme;
}) {
  const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, marginBottom: 8, fontFamily: t.font };
  return (
    <section data-testid="saved-query-report-check" aria-label="Compare with the old report" style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, padding: '12px 14px' }}>
      <div style={sectionLabel}>Compare with the old report</div>
      {status ? (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: status.match ? verdictColor(status.match.verdict, t) : t.textSecondary, overflowWrap: 'anywhere' }}>
          {reportCheckStatusWords(status, certified)}
        </div>
      ) : null}
      <ReportComparePanel query={name} queryPath={path} certified={certified} onRecorded={onRecorded} primaryButton={primaryButton} t={t} />
    </section>
  );
}
