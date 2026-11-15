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
  return `Last compared: ${status.match.words}.`;
}

/** A saved query's standing comparison with an old report, by its name; `reload` after a new one is recorded. */
export function useQueryReportMatch(name: string | undefined): { status: ReportQueryMatch | null; reload: () => void } {
  const [status, setStatus] = useState<ReportQueryMatch | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!name) {
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    void api.getQueryReportMatch(name)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [name, version]);
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

/** The receipt's lines about the old report: then (at certification), and since (a later comparison). */
export function CertificationReportLines({ certification, since, t }: {
  certification: { checks?: string[]; warnings?: string[] } | undefined;
  since: NonNullable<ReportQueryMatch['match']> | null;
  t: Theme;
}) {
  const { matched, warnings } = reportMatchReceipt(certification);
  return (
    <>
      {matched.map((line) => (
        <div key={line} data-testid="block-certification-report-match" style={{ color: 'var(--status-success)' }}>Old report when certified: {line}</div>
      ))}
      {warnings.map((line) => (
        <div key={line} data-testid="block-certification-report-warning" style={{ color: 'var(--status-warning)' }}>Old report when certified: {line}</div>
      ))}
      {since ? (
        <div data-testid="block-certification-report-since" style={{ color: verdictColor(since.verdict, t) }}>Old report since certified: {since.words}</div>
      ) : null}
    </>
  );
}

/** Beside the Certified badge, when a comparison after certification differs. */
export function DiffersSinceCertifiedBadge({ since }: { since: NonNullable<ReportQueryMatch['match']> | null }) {
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
