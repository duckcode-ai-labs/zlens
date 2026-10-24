import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockToolbarActions } from './BlockStudio';

const noop = () => {};
const base = {
  readOnlyReason: 'Production follows main.',
  hasActiveDraft: true,
  activeBlockPath: 'blocks/revenue.dql',
  detail: false,
  running: false,
  saving: false,
  certifying: false,
  certified: false,
  onDelete: noop, onNew: noop, onAsk: noop, onModify: noop, onRun: noop, onSave: noop, onCertify: noop,
};

describe('Block Studio toolbar under a read-only host', () => {
  it('shows no edit button when the person only has project.read, but keeps Run', () => {
    const html = renderToStaticMarkup(<BlockToolbarActions {...base} readOnly />);
    for (const label of ['Save draft', 'Certify', 'New saved query', 'Delete', 'Modify with AI', 'Ask AI']) {
      expect(html).not.toContain(label);
    }
    expect(html).toContain('Run');
  });

  it('shows every edit button when the person may author', () => {
    const html = renderToStaticMarkup(<BlockToolbarActions {...base} readOnly={false} />);
    for (const label of ['Save draft', 'Certify', 'New saved query', 'Delete', 'Modify with AI']) {
      expect(html).toContain(label);
    }
  });
});
