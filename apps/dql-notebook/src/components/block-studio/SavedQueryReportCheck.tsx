import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from '../../api/client';
import type { ReportQueryMatch, ReportVerdict } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { ReportComparePanel } from './ReportComparePanel';

/**
 * The old report check on a saved query's own page: its last comparison, and
 * the box to compare it again. Certifying puts the result on the receipt.
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
export function reportCheckStatusWords(status: ReportQueryMatch | null): string {
  if (!status) return '';
  if (status.unreadable) return status.unreadable;
  if (!status.match) return 'Not compared with an old report yet. Compare it with an export of the report it replaces: every value is checked, and certifying records the result on its receipt.';
  return `Last compared: ${status.match.words}.`;
}

export function SavedQueryReportCheck({ name, path, primaryButton, t }: {
  name: string;
  path?: string;
  primaryButton: CSSProperties;
  t: Theme;
}) {
  const [status, setStatus] = useState<ReportQueryMatch | null>(null);
  const load = useCallback(() => {
    let cancelled = false;
    void api.getQueryReportMatch(name)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [name]);
  useEffect(() => load(), [load]);

  const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, marginBottom: 8, fontFamily: t.font };
  return (
    <section data-testid="saved-query-report-check" aria-label="Compare with the old report" style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, padding: '12px 14px' }}>
      <div style={sectionLabel}>Compare with the old report</div>
      {status ? (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: status.match ? verdictColor(status.match.verdict, t) : t.textSecondary, overflowWrap: 'anywhere' }}>
          {reportCheckStatusWords(status)}
        </div>
      ) : null}
      <ReportComparePanel query={name} queryPath={path} onRecorded={() => { load(); }} primaryButton={primaryButton} t={t} />
    </section>
  );
}
