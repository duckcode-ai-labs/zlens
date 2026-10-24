import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BLOCK_TESTS_HINT, BlockDetailView } from './BlockStudio';
import { themes } from '../../themes/notebook-theme';

const noop = () => {};
const receipt = {
  certifiedBy: 'analytics',
  certifiedAt: '2026-10-01T00:00:00.000Z',
  via: 'block-studio',
  rules: 'oss' as const,
  sourceSha256: 'a'.repeat(64),
};

const overview = (metadata: Record<string, unknown>) => renderToStaticMarkup(
  <BlockDetailView
    metadata={{ name: 'revenue', reviewStatus: 'certified', certification: receipt, ...metadata } as never}
    source=""
    parameters={[]}
    preview={null}
    lineageDetail={null}
    isSemanticBlock={false}
    running={false}
    onOpenBuilder={noop}
    onOpenSource={noop}
    onRun={noop}
    onOpenHistory={noop}
    t={themes.paper}
  />,
);

describe('Block overview of a certified block', () => {
  it('shows the receipt and no warning while the source is the certified one', () => {
    const html = overview({});
    expect(html).toContain('Certified by analytics');
    expect(html).not.toContain('block-certification-source-changed');
  });

  it('shows Recertify and says why when the source was edited after certification', () => {
    const html = overview({ certificationSourceChanged: true });
    expect(html).toContain('Certified by analytics');
    expect(html).toContain('block-certification-source-changed');
    expect(html).toContain('Edited after it was certified');
    expect(html).toContain('Recertify');
  });
});

describe('Builder Tests hint', () => {
  it('says tests are optional and run on Certify', () => {
    expect(BLOCK_TESTS_HINT).toMatch(/^Optional\. Certify runs them/);
    expect(BLOCK_TESTS_HINT).not.toContain('required for certification');
  });
});
