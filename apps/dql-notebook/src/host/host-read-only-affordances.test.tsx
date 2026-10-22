import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WelcomeScreen } from '../components/notebook/WelcomeScreen';
import { NotebookFileRow } from '../components/panels/BuildSidebar';
import { BlockDetailView } from '../components/block-studio/BlockStudio';
import { themes } from '../themes/notebook-theme';
import { HostUiProvider, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };
const viewer: HostUiState = { host: true, person: { id: 'u1', name: 'Vic', kind: 'person' }, capabilities: { 'project.read': true }, links: [], answerActions: [] };
const author: HostUiState = { ...viewer, capabilities: { 'project.read': true, 'project.write': true, 'dataset.author': true } };
const t = themes.paper;
const noop = () => {};

const welcome = (state: HostUiState) => renderToStaticMarkup(
  <HostUiProvider initial={state}><WelcomeScreen onOpenFile={noop} /></HostUiProvider>,
);

describe('Notebooks landing screen', () => {
  it('hides New Notebook and New Block for a project.read-only viewer, keeps Home', () => {
    const html = welcome(viewer);
    expect(html).not.toContain('New Notebook');
    expect(html).not.toContain('New saved query');
    expect(html).toContain('Home');
  });

  it('shows both with the write actions, and with no host', () => {
    for (const state of [author, NO_HOST]) {
      const html = welcome(state);
      expect(html).toContain('New Notebook');
      expect(html).toContain('New saved query');
    }
  });
});

describe('Notebook list row', () => {
  const file = { name: 'a.dqlnb', path: 'notebooks/a.dqlnb', type: 'notebook', visibility: 'private' } as never;
  const row = (props: { onDelete?: () => void; onPublish?: () => void }) => renderToStaticMarkup(
    <NotebookFileRow file={file} active={false} onOpenFile={noop} publishing={false} t={t} depth={0} {...props} />,
  );

  it('has no Delete or Publish button without the handlers', () => {
    const html = row({});
    expect(html).not.toContain('Delete a.dqlnb');
    expect(html).not.toContain('Publish a.dqlnb');
    expect(html).toContain('notebooks/a.dqlnb');
  });

  it('has both when the handlers are given', () => {
    const html = row({ onDelete: noop, onPublish: noop });
    expect(html).toContain('Delete a.dqlnb');
    expect(html).toContain('Publish a.dqlnb');
  });
});

describe('Block overview', () => {
  const view = (onDelete?: () => void) => renderToStaticMarkup(
    <BlockDetailView
      metadata={{ name: 'revenue', reviewStatus: 'draft' } as never}
      source=""
      parameters={[]}
      preview={null}
      lineageDetail={null}
      isSemanticBlock={false}
      running={false}
      onOpenBuilder={noop}
      onOpenSource={noop}
      onDelete={onDelete}
      onRun={noop}
      onOpenHistory={noop}
      t={t}
    />,
  );

  it('draws no Delete button without onDelete, but keeps Run', () => {
    const html = view();
    expect(html).not.toContain('Delete revenue');
    expect(html).toContain('Run');
  });

  it('draws Delete when onDelete is given', () => {
    expect(view(noop)).toContain('Delete revenue');
  });
});
