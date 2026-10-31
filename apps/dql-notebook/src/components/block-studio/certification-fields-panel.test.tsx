import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CertificationFieldsPanel, certificationFillWords } from './BlockStudio';
import { themes } from '../../themes/notebook-theme';

const noop = () => {};
const panel = (source: string) => renderToStaticMarkup(
  <CertificationFieldsPanel source={source} onChange={noop} onFill={noop} filling={false} testPlaceholder="assert row_count >= 1" t={themes.paper} />,
);

const EMPTY = 'block "West claims" {\n  status = "draft"\n  query = """SELECT 1 AS one"""\n}\n';
const FILLED = `block "West claims" {
  status = "draft"
  grain = "one row per region"
  outputs = ["region", "open_claims"]
  reviewCadence = "monthly"
  sourceSystems = ["model.harbor.claims"]
  query = """SELECT 1 AS one"""

  tests {
    assert row_count > 0
  }
}
`;

describe('Certification panel in the Visual Builder', () => {
  it('has a field for everything Certify asks of a creator', () => {
    const html = panel(EMPTY);
    for (const label of ['Grain', 'Review cadence', 'Outputs', 'Source systems', 'Tests']) expect(html).toContain(label);
  });

  it('says what is still empty and offers to fill it from the query', () => {
    const html = panel(EMPTY);
    expect(html).toContain('Not filled yet: grain, outputs, review cadence, source systems, a test.');
    expect(html).toContain('Fill from the query');
  });

  it('shows what the source already declares, and asks for nothing more', () => {
    const html = panel(FILLED);
    expect(html).toContain('value="one row per region"');
    expect(html).toContain('open_claims ×');
    expect(html).toContain('model.harbor.claims ×');
    expect(html).toContain('assert row_count &gt; 0');
    expect(html).toContain('Every certification field is filled.');
    expect(html).not.toContain('Fill from the query');
  });

  it('keeps a cadence typed in source that is not on the list', () => {
    expect(panel(FILLED.replace('monthly', 'every sprint'))).toContain('every sprint');
  });
});

describe('what the fill says it did', () => {
  it('names the fields it filled and the ones it could not, in plain words', () => {
    expect(certificationFillWords(['outputs', 'reviewCadence', 'tests'], ['grain'])).toEqual({
      filled: 'ZLens filled outputs, review cadence, a test.',
      missing: 'ZLens could not fill grain: the query does not say. Fill it in the Certification panel.',
    });
  });

  it('says nothing about what did not happen', () => {
    expect(certificationFillWords([], [])).toEqual({ filled: '', missing: '' });
    expect(certificationFillWords(['grain'], []).missing).toBe('');
  });
});
