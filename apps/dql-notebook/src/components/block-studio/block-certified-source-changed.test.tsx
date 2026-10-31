import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BLOCK_TESTS_HINT, BlockDetailView, BlockToolbarActions, blockIdentityDialogCopy, certificationPanelHeading, certificationPassedLine, certificationProposalLine, certifyButtonLabel } from './BlockStudio';
import { BlockRow } from '../panels/BuildSidebar';
import { HostUiProvider, type HostUi } from '../../host/host-ui';
import { blockDisplayStatus, blockStatusLabel } from '../blocks/BlockStatusBadge';
import { themes } from '../../themes/notebook-theme';

const noop = () => {};
const receipt = {
  certifiedBy: 'analytics',
  certifiedAt: '2026-10-01T00:00:00.000Z',
  via: 'block-studio',
  rules: 'oss' as const,
  sourceSha256: 'a'.repeat(64),
};

const overview = (metadata: Record<string, unknown>, proposes = false) => renderToStaticMarkup(
  <BlockDetailView
    metadata={{ name: 'revenue', reviewStatus: 'certified', certification: receipt, ...metadata } as never}
    source=""
    parameters={[]}
    preview={null}
    lineageDetail={null}
    isSemanticBlock={false}
    running={false}
    proposes={proposes}
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

describe('Certify where the host certifies through review', () => {
  const byDan = { ...receipt, certifiedBy: 'dan@harbor.example', certifiedByName: 'Dan Creator', certifiedAt: '2026-10-31T12:00:00.000Z' };

  it('shows a proposal, not Certified, for a certification made on this branch', () => {
    const html = overview({ certification: byDan, certificationProposed: true }, true);
    expect(html).toContain('Certification proposed by Dan Creator');
    expect(html).toContain('takes effect when a reviewer approves');
    expect(html).not.toContain('Certified by');
    expect(html).not.toContain('>Certified<');
    expect(certificationProposalLine(byDan)).toMatch(/^Certification proposed by Dan Creator · .*: takes effect when a reviewer approves\.$/);
  });

  it('keeps a block inherited as certified Certified, under the same host', () => {
    const html = overview({ certification: byDan }, true);
    expect(html).toContain('Certified by Dan Creator');
    expect(html).not.toContain('Certification proposed');
  });

  it('changes nothing without the host, whatever the block says', () => {
    const html = overview({ certification: byDan, certificationProposed: true }, false);
    expect(html).toContain('Certified by Dan Creator');
    expect(html).not.toContain('Certification proposed');
    expect(blockDisplayStatus('certified', { certificationProposed: true }, false)).toBe('certified');
  });

  it('badges a proposal and leaves every other status alone', () => {
    expect(blockDisplayStatus('certified', { certificationProposed: true }, true)).toBe('proposed');
    expect(blockDisplayStatus('draft', { certificationProposed: true }, true)).toBe('draft');
    expect(blockDisplayStatus('certified', {}, true)).toBe('certified');
    expect(blockStatusLabel('proposed')).toBe('Certification proposed');
  });

  it('says propose on the button, in the dialog and in the checklist', () => {
    expect(certifyButtonLabel(false, true)).toBe('Propose certification');
    expect(certifyButtonLabel(true, true)).toBe('Propose again');
    expect(blockIdentityDialogCopy('certify', true).body).toContain('takes effect when a reviewer approves');
    expect(certificationPanelHeading({ ok: true }, true)).toBe('Certification proposed');
    expect(certificationPassedLine(true, true)).toBe('Latest edits were saved, the saved query ran successfully, tests passed, and certification is proposed. It takes effect when a reviewer approves.');
    const toolbar = { readOnly: false, readOnlyReason: '', hasActiveDraft: true, activeBlockPath: 'blocks/a.dql', detail: false, running: false, saving: false, certifying: false, certified: false, onDelete: noop, onNew: noop, onAsk: noop, onModify: noop, onRun: noop, onSave: noop, onCertify: noop };
    expect(renderToStaticMarkup(<BlockToolbarActions {...toolbar} proposes />)).toContain('Propose certification');
  });

  it('keeps the words of a plain Certify', () => {
    expect(certifyButtonLabel(false)).toBe('Certify');
    expect(certifyButtonLabel(true)).toBe('Re-certify');
    expect(certificationPanelHeading({ ok: true })).toBe('Saved query certified');
    expect(certificationPassedLine(false)).toBe('Latest edits were saved, the saved query ran successfully, no tests are defined, and status was updated to certified.');
  });

  const row = (host: HostUi | { host: false }, block: Record<string, unknown>) => renderToStaticMarkup(
    <HostUiProvider initial={host}>
      <BlockRow block={{ name: 'open_claims', domain: 'claims', status: 'certified', owner: null, tags: [], path: 'blocks/open_claims.dql', lastModified: '', description: '', ...block }} t={themes.paper} onOpen={noop} />
    </HostUiProvider>,
  );
  const proposes = { host: true, person: { id: 'u', name: 'Dan', kind: 'person' }, capabilities: {}, links: [], answerActions: [], certification: 'proposes' } as HostUi;

  it('shows the same in the block list', () => {
    expect(row(proposes, { certificationProposed: true })).toContain('claims · certification proposed');
    expect(row(proposes, {})).toContain('claims · certified');
    expect(row({ host: false }, { certificationProposed: true })).toContain('claims · certified');
  });
});

describe('Builder Tests hint', () => {
  it('says tests are optional and run on Certify', () => {
    expect(BLOCK_TESTS_HINT).toMatch(/^Optional\. Certify runs them/);
    expect(BLOCK_TESTS_HINT).not.toContain('required for certification');
  });
});
