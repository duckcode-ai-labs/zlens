import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportCandidateDetail } from './BlockStudio';
import { themes } from '../../themes/notebook-theme';

const noop = async () => {};

const candidate = {
  id: 'c1',
  name: 'Top Locations By Order Count',
  domain: 'commerce',
  owner: 'analytics@jaffle.shop',
  description: 'Order count per location.',
  tags: [],
  sql: 'select 1',
  dqlSource: 'block "x" {\n  type = "custom"\n  query = """select 1"""\n}',
  sourcePath: 'pasted.sql',
  confidence: 0.8,
  reviewStatus: 'draft',
  lineage: { sourceTables: [], parameters: [], warnings: [], statementIndex: 1, totalStatements: 1 },
  similarityMatches: [],
  parameterDecisions: [],
  filterBindings: [],
};

describe('Import review: Show context', () => {
  it('renders no stray "0" when the draft has no parameters, filter bindings or similar blocks', () => {
    const html = renderToStaticMarkup(
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
        themeMode="light"
        initialContextOpen
        t={themes.paper}
      />,
    );
    expect(html).toContain('Hide context');
    expect(html).not.toMatch(/>0</);
  });
});
