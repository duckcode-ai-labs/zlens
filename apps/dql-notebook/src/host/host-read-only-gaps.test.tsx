import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadOnlyStrip } from '../components/shell/HostReadOnly';
import { SavedQueriesHome } from '../components/block-studio/SavedQueriesHome';
import { themes } from '../themes/notebook-theme';
import { HostUiProvider, hostReadOnly, navItemAllowed, navKeyForView, readOnlyNext, type HostUi, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };
const DRAFT = { label: 'Open my draft space', href: '/e/draft' };

function hosted(capabilities: Record<string, boolean>, refusals?: HostUi['refusals']): HostUi {
  return { host: true, person: { id: 'u1', name: 'Cleo', kind: 'person' }, capabilities, links: [], answerActions: [], ...(refusals ? { refusals } : {}) };
}

const strip = (state: HostUiState, view: string) =>
  renderToStaticMarkup(<HostUiProvider initial={state}><ReadOnlyStrip mainView={view} /></HostUiProvider>);

describe('Saved queries home: Import', () => {
  const noop = () => {};
  const page = (props: { onImport?: () => void; onBuildManually?: () => void; readOnlyReason?: string }) => renderToStaticMarkup(
    <SavedQueriesHome onAskAi={noop} onReviewMetricDraft={noop} t={themes.paper} {...props} />,
  );

  it('shows Import when the handler is given', () => {
    expect(page({ onImport: noop, onBuildManually: noop })).toMatch(/<button[^>]*>.*Import<\/button>/);
  });

  it('hides Import without the handler and gives the reason', () => {
    const html = page({ readOnlyReason: 'Production follows main.' });
    expect(html).not.toMatch(/>\s*Import\s*</);
    expect(html).not.toContain('Import SQL');
    expect(html).toContain('Production follows main.');
  });
});

describe('read-only strip: next step', () => {
  const refusals: HostUi['refusals'] = { 'dataset.author': { reason: 'Production follows main.', next: DRAFT }, 'project.write': { reason: 'Production follows main.', next: DRAFT } };

  it('shows the host\'s next link on all four screens', () => {
    const creator = hosted({ 'project.read': true }, refusals);
    for (const view of ['notebook', 'block_studio', 'lineage', 'modeling']) {
      const html = strip(creator, view);
      expect(html).toContain('Open my draft space');
      expect(html).toContain('href="/e/draft"');
    }
  });

  it('shows no link when the host sent none, and none when the person may write', () => {
    expect(strip(hosted({ 'project.read': true }, { 'dataset.author': { reason: 'No.' } }), 'block_studio')).not.toContain('<a ');
    expect(readOnlyNext(hosted({ 'project.read': true, 'dataset.author': true }, refusals), 'block_library')).toBeNull();
    expect(readOnlyNext(NO_HOST, 'block_library')).toBeNull();
  });
});

describe('Source control for read-only people', () => {
  it('shows to project.read, read-only, with the host\'s next step', () => {
    const creator = hosted({ 'project.read': true }, { 'git.review': { reason: 'Production is read-only.', next: DRAFT } });
    expect(navItemAllowed(creator, 'git')).toBe(true);
    expect(hostReadOnly(creator, 'git')).toBe(true);
    expect(navKeyForView('git')).toBe('git');
    const html = strip(creator, 'git');
    expect(html).toContain('Production is read-only.');
    expect(html).toContain('Open my draft space');
  });

  it('edits only with git.review; stays hidden without project.read or git.review', () => {
    const reviewer = hosted({ 'project.read': true, 'git.review': true });
    expect(hostReadOnly(reviewer, 'git')).toBe(false);
    expect(strip(reviewer, 'git')).toBe('');
    expect(navItemAllowed(hosted({ ask: true }), 'git')).toBe(false);
    expect(navItemAllowed(hosted({ 'git.review': true }), 'git')).toBe(true);
  });

  it('is unchanged without a host', () => {
    expect(navItemAllowed(NO_HOST, 'git')).toBe(true);
    expect(hostReadOnly(NO_HOST, 'git')).toBe(false);
  });
});
