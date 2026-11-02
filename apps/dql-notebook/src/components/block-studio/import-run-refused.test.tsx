import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DqlApiError } from '../../api/client';
import { ImportCandidateDetail } from './BlockStudio';
import { importRunError } from './import-run-error';
import { themes } from '../../themes/notebook-theme';

/**
 * Import SQL, Run on a draft under a host whose row policy refuses the person: the server answers 403
 * `POLICY_DENIED` in the rule's words, and the page shows that sentence as "Not run", the way the Block
 * Studio card does (#238), not as "Preview failed" with a repair on offer.
 */
const noop = async () => {};
const sentence = 'Your profile has no region, which claims needs to show you any rows. Ask an admin.';
const candidate = {
  id: 'c1', name: 'Claims by region', domain: 'claims', owner: 'priya@harbor.example', description: 'Claims per region.', tags: [],
  sql: 'select region from claims', dqlSource: 'block "x" {\n  type = "custom"\n  query = """select region from claims"""\n}', sourcePath: 'pasted.sql',
  confidence: 0.8, reviewStatus: 'draft', lineage: { sourceTables: [], parameters: [], warnings: [], statementIndex: 1, totalStatements: 1 },
  similarityMatches: [], parameterDecisions: [], filterBindings: [],
};
const render = (runError: { message: string; refused: boolean } | null) => renderToStaticMarkup(
  <ImportCandidateDetail
    session={{ id: 's1', candidates: [candidate] } as never}
    candidate={candidate as never}
    loading={false}
    onCandidateUpdated={() => {}}
    onRun={noop}
    onSave={noop}
    onCertify={noop}
    onReject={noop}
    onReviewInEditor={() => {}}
    runError={runError}
    themeMode="light"
    t={themes.paper}
  />,
);

describe('Import SQL: a run the host refused', () => {
  it('is read from the 403 as a refusal, in the rule\'s words', () => {
    expect(importRunError(new DqlApiError({ message: sentence, status: 403, code: 'POLICY_DENIED' }))).toEqual({ message: sentence, refused: true });
    expect(importRunError(new DqlApiError({ message: 'Binder Error: column "regon" not found', status: 500, code: 'BLOCK_PREVIEW_FAILED' }))).toEqual({ message: 'Binder Error: column "regon" not found', refused: false });
    expect(importRunError(undefined)).toEqual({ message: 'Candidate run failed.', refused: false });
  });

  it('is shown as "Not run" with the sentence, never as a preview failure', () => {
    const html = render({ message: sentence, refused: true });
    expect(html).toContain('Not run');
    expect(html).toContain(sentence);
    expect(html).toContain('the draft itself is not at fault');
    expect(html).not.toContain('Preview failed');
    const failed = render({ message: 'Binder Error', refused: false });
    expect(failed).toContain('Preview failed: Binder Error');
    expect(failed).not.toContain('Not run');
  });
});
