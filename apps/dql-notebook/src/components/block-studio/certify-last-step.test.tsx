import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CERTIFY_REVIEW_LINE, CertificationChecklistPanel, awaitsOnlyAiReview, certificationPanelHeading, checkedAtLabel } from './BlockStudio';
import { themes } from '../../themes/notebook-theme';

const noop = () => {};
const passedChecks = { metadata: true, validation: true, run: true, tests: false, chart: false, lineage: true, aiReviewed: false };
const reviewIssue = {
  severity: 'error' as const,
  code: 'ai_review_required',
  title: 'Confirm you reviewed what AI wrote',
  field: 'Review',
  message: 'AI wrote this saved query. Read its SQL and its result, then confirm you reviewed them before certifying.',
  correction: 'Check the SQL and the rows it returns, then click "I reviewed it — certify".',
  action: 'confirm_ai_review' as const,
};
const runIssue = {
  severity: 'error' as const,
  code: 'certification_blocker',
  title: 'Certification requirement is not ready',
  message: 'The query must run successfully.',
  action: 'run_again' as const,
};

function panel(checklist: Record<string, unknown>, withReviewButton = true) {
  return renderToStaticMarkup(
    <CertificationChecklistPanel
      result={{ ok: false, checklist: checklist as never }}
      t={themes.paper}
      repairing={false}
      onEditSource={noop}
      onEditParameters={noop}
      onReviewMetrics={noop}
      onRun={noop}
      onFix={noop}
      onConfirmAiReview={withReviewButton ? noop : undefined}
    />,
  );
}

describe('Certify on a saved query AI wrote (P2-1)', () => {
  it('shows the review as a calm last step, with the button first', () => {
    const html = panel({ ...passedChecks, blockers: [reviewIssue.message], issues: [reviewIssue], checkedAt: '2026-11-28T00:45:54.379Z' });
    expect(html).toContain('One last step: confirm you reviewed it');
    expect(html).toContain(CERTIFY_REVIEW_LINE);
    expect(html).toContain('I reviewed it — certify');
    expect(html).toContain('Edit the SQL');
    expect(html.indexOf('I reviewed it — certify')).toBeLessThan(html.indexOf('Metadata'));
    for (const alarm of ['Unable to certify', 'required fix', 'Fixes before certification', 'How to fix', '2026-11-28T00:45:54']) {
      expect(html).not.toContain(alarm);
    }
  });

  it('keeps the fix list when a real fix is left beside the review', () => {
    const html = panel({ ...passedChecks, run: false, blockers: [runIssue.message, reviewIssue.message], issues: [runIssue, reviewIssue] });
    expect(html).toContain('Unable to certify');
    expect(html).toContain('Fixes before certification · 2');
    expect(html).not.toContain('One last step');
  });

  it('keeps the fix list when there is no review button to press', () => {
    const html = panel({ ...passedChecks, blockers: [reviewIssue.message], issues: [reviewIssue] }, false);
    expect(html).toContain('Unable to certify');
    expect(html).not.toContain('One last step');
  });

  it('knows which issues are only the review', () => {
    expect(awaitsOnlyAiReview([reviewIssue])).toBe(true);
    expect(awaitsOnlyAiReview([{ code: 'ai_review_required' }])).toBe(true);
    expect(awaitsOnlyAiReview([reviewIssue, runIssue])).toBe(false);
    expect(awaitsOnlyAiReview([])).toBe(false);
  });

  it('keeps the other headings', () => {
    expect(certificationPanelHeading({ ok: false })).toBe('Unable to certify');
    expect(certificationPanelHeading({ ok: false }, false, true)).toBe('One last step: confirm you reviewed it');
    expect(certificationPanelHeading({ ok: true }, false, true)).toBe('Saved query certified');
    expect(certificationPanelHeading({ pending: true }, false, true)).toBe('Certification running');
  });

  it('shows the check time in the viewer\'s own time, not raw UTC', () => {
    expect(checkedAtLabel('2026-11-28T00:45:54.379Z')).toMatch(/^Checked \d{1,2}:\d{2}/);
    expect(checkedAtLabel('2026-11-28T00:45:54.379Z')).not.toContain('T00:45');
    expect(checkedAtLabel(undefined)).toBeUndefined();
    expect(checkedAtLabel('not a date')).toBeUndefined();
  });
});
