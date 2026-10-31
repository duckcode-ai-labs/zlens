import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRun } from '../api/client';
import { HostAnswerActions, HostAnswerStatusView, HostNoteBox, actionsForAnswer, answerActionInput, answerCanBeCertified, answerNeedsReview, answerRanSql } from '../components/agent/HostAnswerActions';
import { HostPersonMenu } from '../components/shell/HostPersonMenu';
import { HostBanner } from '../components/shell/HostBanner';
import { themes } from '../themes/notebook-theme';
import { HOST_UNREACHABLE_AFTER_MS, HostConnecting, HostUiProvider, hostAllows, hostPageSrc, hostProposesCertification, hostReader, hostRefusal, hostUiFrom, navItemAllowed, pageSaysHosted, runHostAnswerAction, type HostUi, type HostUiState } from './host-ui';
import { appLibraryWords } from '../components/apps/app-library-words';

const NO_HOST: HostUiState = { host: false };

function hosted(overrides: Partial<HostUi> = {}): HostUi {
  return {
    host: true,
    person: { id: 'u_priya', name: 'Priya Shah', email: 'priya@harbor.example', kind: 'person' },
    capabilities: { ask: true, 'query.run': true },
    signOutUrl: '/auth/logout',
    environment: 'Production',
    links: [{ id: 'requests', label: 'My requests', href: '/e/requests', placement: 'nav' }],
    answerActions: [
      { id: 'check', label: 'Ask an analyst to check this', url: '/enterprise/api/requests' },
      { id: 'note', label: 'Add a note', url: '/enterprise/api/notes' },
    ],
    ...overrides,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return { id: 'run_1', question: 'Claims paid last month?', status: 'needs_review', trustState: 'review_required', ...overrides } as AgentRun;
}

const t = themes.dark;

function render(state: HostUiState, node: JSX.Element): string {
  return renderToStaticMarkup(<HostUiProvider initial={state}>{node}</HostUiProvider>);
}

describe('host UI (RFC 0010 HH-9)', () => {
  it('without a host the local owner may do everything, as before', () => {
    for (const action of ['ask', 'dataset.certify', 'settings.manage']) expect(hostAllows(NO_HOST, action)).toBe(true);
    for (const key of ['ask', 'files', 'block_library', 'git', 'settings', 'apps']) expect(navItemAllowed(NO_HOST, key)).toBe(true);
  });

  it('with a host, screens follow what the person may do', () => {
    const priya = hosted();
    expect(hostAllows(priya, 'ask')).toBe(true);
    expect(hostAllows(priya, 'dataset.certify')).toBe(false);
    expect(navItemAllowed(priya, 'ask')).toBe(true);
    expect(navItemAllowed(priya, 'files')).toBe(false);
    expect(navItemAllowed(priya, 'block_library')).toBe(false);
    expect(navItemAllowed(priya, 'settings')).toBe(false);
    // Screens with no rule (Apps, Home) stay; their own routes check access.
    expect(navItemAllowed(priya, 'apps')).toBe(true);
    // Settings opens for either settings or connection managers.
    expect(navItemAllowed(hosted({ capabilities: { 'connection.manage': true } }), 'settings')).toBe(true);
  });

  it('says why an action is refused and where to ask, only under a host and only for what is refused', () => {
    expect(hostRefusal(NO_HOST, 'ask')).toBeNull();
    expect(hostRefusal(hosted(), 'ask')).toBeNull();
    const vic = hosted({ capabilities: { ask: false }, refusals: { ask: { reason: 'Asking needs the explorer role in this workspace.', next: { label: 'Request access', href: '/e/access' } } } });
    expect(hostRefusal(vic, 'ask')).toEqual({ reason: 'Asking needs the explorer role in this workspace.', next: { label: 'Request access', href: '/e/access' } });
    // Refused without a reason: still refused (the screen uses its own words).
    expect(hostRefusal(hosted({ capabilities: {} }), 'ask')).toEqual({});
  });

  it('speaks to a reader in plain words, and is unchanged without a host or for authors', () => {
    expect(hostReader(NO_HOST)).toBe(false);
    expect(hostReader(hosted())).toBe(false);
    expect(hostReader(hosted({ audience: 'reader' }))).toBe(true);
    const local = appLibraryWords(false);
    expect(local.filters).toEqual(['all', 'drafts', 'private', 'shared', 'fav']);
    expect(local.label('drafts')).toBe('Not published yet');
    expect(local.loadingDetail).toBe('Reading local app files from this ZLens project.');
    const reader = appLibraryWords(true);
    expect(reader.filters).toEqual(['all', 'shared', 'fav']);
    expect(reader.label('shared')).toBe('Shared Apps');
    expect(reader.localCounts).toBe(false);
    const words = [reader.intro, reader.loadingDetail, reader.emptyDetail, reader.appNote({ name: 'Claims Weekly', domain: 'claims' }), ...reader.filters.map(reader.label)].join(' ');
    expect(words).not.toMatch(/local|draft|private|consumption surface|project/i);
  });

  it('shows the host banner above every screen, with its links at the top level', () => {
    expect(render(NO_HOST, <HostBanner />)).toBe('');
    expect(render(hosted(), <HostBanner />)).toBe('');
    const html = render(hosted({ banner: { text: 'Draft space — changes go to review, not Production', tone: 'caution', links: [{ label: 'Back to Production', href: '/enterprise/env/production' }] } }), <HostBanner />);
    expect(html).toContain('Draft space — changes go to review, not Production');
    expect(html).toContain('href="/enterprise/env/production"');
    expect(html).toContain('target="_top"');
    expect(html).toContain('role="status"');
  });

  it('opens host pages embedded', () => {
    expect(hostPageSrc('/e/requests')).toBe('/e/requests?embed=1');
    expect(hostPageSrc('/e/reviews?state=open')).toBe('/e/reviews?state=open&embed=1');
  });

  it('shows the person and sign-out only under a host', () => {
    expect(render(NO_HOST, <HostPersonMenu />)).toBe('');
    const html = render(hosted(), <HostPersonMenu />);
    expect(html).toContain('Account: Priya Shah');
    expect(html).toContain('>PS<');
    expect(html).toContain('Production');
  });

  it('offers the host answer actions only on answers that need review', () => {
    expect(answerNeedsReview(run())).toBe(true);
    expect(answerNeedsReview(run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>))).toBe(false);

    expect(render(NO_HOST, <HostAnswerActions run={run()} t={t} />)).toBe('');
    expect(render(hosted({ answerActions: [] }), <HostAnswerActions run={run()} t={t} />)).toBe('');
    expect(render(hosted(), <HostAnswerActions run={run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>)} t={t} />)).toBe('');

    const html = render(hosted(), <HostAnswerActions run={run()} t={t} />);
    expect(html).toContain('data-testid="host-answer-actions"');
    expect(html).toContain('Ask an analyst to check this');
    expect(html).toContain('Add a note');
  });

  it('offers an action meant for questions ZLens could not answer on a blocked answer, and nothing else', () => {
    const withUnanswered = hosted({ answerActions: [
      { id: 'check', label: 'Ask an analyst to check this', url: '/x' },
      { id: 'ask', label: 'Ask a data person', url: '/y', on: ['unanswered'] },
    ] });
    const blocked = run({ status: 'blocked', trustState: 'blocked' } as Partial<AgentRun>);
    const html = render(withUnanswered, <HostAnswerActions run={blocked} t={t} />);
    expect(html).toContain('Ask a data person');
    expect(html).not.toContain('Ask an analyst to check this');
    expect(html).toContain('could not answer this');
    expect(render(hosted(), <HostAnswerActions run={blocked} t={t} />)).toBe('');
  });

  it('offers "This looks wrong" quietly on an answer DQL trusts, and nothing else there', () => {
    const withWrong = hosted({ answerActions: [
      { id: 'check', label: 'Ask an analyst to check this', url: '/x' },
      { id: 'wrong', label: 'This looks wrong', url: '/z', on: ['answered', 'review'] },
    ] });
    const certified = run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>);
    const html = render(withWrong, <HostAnswerActions run={certified} t={t} />);
    expect(html).toContain('data-testid="host-quiet-actions"');
    expect(html).toContain('This looks wrong');
    expect(html).not.toContain('Ask an analyst to check this');
    // On a review answer it sits with the other actions.
    expect(render(withWrong, <HostAnswerActions run={run()} t={t} />)).toContain('This looks wrong');
  });
});

describe('"Make this a certified answer" (only an AI answer that ran SQL)', () => {
  const certify = { id: 'certify', label: 'Make this a certified answer', url: '/y', on: ['review', 'unanswered'] as Array<'review' | 'unanswered'> };
  const ran = (payload: Record<string, unknown> = { result: { sql: 'SELECT 1', columns: ['a'], rows: [] } }) =>
    [{ id: 'a1', kind: 'answer', title: 'Answer', trustState: 'review_required', payload }] as AgentRun['artifacts'];
  const offered = (overrides: Partial<AgentRun>) => actionsForAnswer(run(overrides), [certify])?.actions.map((action) => action.id) ?? [];

  it('is offered on a needs-review answer whose SQL ran', () => {
    expect(offered({ artifacts: ran() })).toEqual(['certify']);
    expect(render(hosted({ answerActions: [certify] }), <HostAnswerActions run={run({ artifacts: ran() })} t={t} />)).toContain('Make this a certified answer');
  });

  it('is still offered where the figures are withheld, and on a run rebuilt from its thread', () => {
    expect(answerRanSql({ artifacts: ran({ result: { rows: [], rowCount: 3, sql: 'SELECT 1' } }) })).toBe(true);
    expect(answerRanSql({ artifacts: ran({ sql: 'SELECT 1', result: { columns: ['a'], rows: [] } }) })).toBe(true);
  });

  it('is never offered on a blocked answer, whatever the host says about it', () => {
    const warehouseError = run({ status: 'blocked', trustState: 'blocked', artifacts: ran({ sql: 'SELECT 1', executionError: 'The warehouse could not run this statement.' }) });
    const refusal = run({ status: 'blocked', trustState: 'blocked', artifacts: [] });
    const blockedAfterRunning = run({ status: 'blocked', trustState: 'review_required', artifacts: ran() });
    for (const blocked of [warehouseError, refusal, blockedAfterRunning]) {
      expect(answerCanBeCertified(blocked)).toBe(false);
      expect(actionsForAnswer(blocked, [certify])).toBeNull();
      expect(render(hosted({ answerActions: [certify] }), <HostAnswerActions run={blocked} t={t} />)).toBe('');
    }
  });

  it('is never offered where no SQL ran', () => {
    expect(offered({ artifacts: [] })).toEqual([]);
    expect(offered({ artifacts: ran({ sql: 'SELECT 1', executionError: 'It failed.' }) })).toEqual([]);
    expect(offered({ artifacts: ran({ sql: 'SELECT 1', result: { sql: 'SELECT 1', rows: [] }, executionError: 'It failed.' }) })).toEqual([]);
    expect(offered({ artifacts: ran({ proposedSql: 'SELECT 1' }) })).toEqual([]);
    expect(offered({ artifacts: ran({ sql: 'SELECT 1' }) })).toEqual([]);
    expect(offered({ artifacts: ran({ result: { columns: ['a'], rows: [] } }) })).toEqual([]);
  });

  it('is never offered on a clarification, a conversational reply, a stopped run or a trusted answer', () => {
    const artifacts = ran();
    expect(offered({ status: 'needs_clarification', trustState: 'review_required', artifacts })).toEqual([]);
    expect(offered({ status: 'cancelled', trustState: 'review_required', artifacts })).toEqual([]);
    expect(offered({ status: 'completed', trustState: 'not_applicable', answerKind: 'conversational', artifacts: [] })).toEqual([]);
    expect(offered({ status: 'needs_review', trustState: 'not_applicable', artifacts })).toEqual([]);
    expect(offered({ status: 'completed', trustState: 'certified', artifacts })).toEqual([]);
  });

  it('leaves the other actions on a review answer alone', () => {
    const check = { id: 'check', label: 'Ask an analyst to check this', url: '/x' };
    expect(actionsForAnswer(run({ artifacts: [] }), [check, certify])?.actions).toEqual([check]);
  });
});

describe('"This looks wrong" takes a note first', () => {
  const wrong = { id: 'wrong', label: 'This looks wrong', url: '/enterprise/api/requests?kind=correction', on: ['answered', 'review'] as Array<'answered' | 'review'> };
  afterEach(() => vi.unstubAllGlobals());

  it('shows one optional line and Send', () => {
    const html = renderToStaticMarkup(<HostNoteBox action={wrong} sending={false} onSend={vi.fn()} onCancel={vi.fn()} t={t} />);
    expect(html).toContain('data-testid="host-note-box"');
    expect(html).toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('required');
    expect(html).toContain('placeholder="What looks wrong? (optional)"');
    expect(html).toContain('>Send<');
    expect(html).toContain('>Cancel<');
    expect(renderToStaticMarkup(<HostNoteBox action={wrong} sending onSend={vi.fn()} onCancel={vi.fn()} t={t} />)).toContain('>Sending…<');
  });

  it('files nothing until the person sends: the card only shows the action', () => {
    const certified = run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>);
    expect(render(hosted({ answerActions: [wrong] }), <HostAnswerActions run={certified} t={t} />)).not.toContain('host-note-box');
  });

  it('sends what was written with the request, and no note when nothing was', () => {
    const answer = run({ trustState: 'certified' } as Partial<AgentRun>);
    expect(answerActionInput(answer, '  The total counts refunds twice.  ')).toEqual({ runId: 'run_1', question: 'Claims paid last month?', trustState: 'certified', note: 'The total counts refunds twice.' });
    expect(answerActionInput(answer, '   ')).toEqual({ runId: 'run_1', question: 'Claims paid last month?', trustState: 'certified' });
    expect(answerActionInput(answer)).not.toHaveProperty('note');
  });

  it('posts the note to the host', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ message: 'Reported as R-7.' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const message = await runHostAnswerAction(wrong, answerActionInput(run(), 'The total counts refunds twice.'));
    expect(message).toBe('Reported as R-7.');
    expect(fetchMock.mock.calls[0][0]).toBe(wrong.url);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ runId: 'run_1', note: 'The total counts refunds twice.' });
  });
});

describe('the host\'s review of an answer (HH-10)', () => {
  it('shows where it stands, with the page that tells the whole story', () => {
    const html = render(hosted(), <HostAnswerStatusView status={{ state: 'checked', label: 'Checked by Dan Kim', detail: 'Matches the claims ledger.', href: '/e/requests/R-142' }} t={t} />);
    expect(html).toContain('data-state="checked"');
    expect(html).toContain('Checked by Dan Kim');
    expect(html).toContain('Matches the claims ledger.');
    expect(html).toContain('>Open<');
    expect(render(hosted(), <HostAnswerStatusView status={{ state: 'requested', label: 'Request R-142 · waiting for a steward' }} t={t} />)).not.toContain('>Open<');
  });
});

describe('host sign-in on a refused request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('goes to the host sign-in once and comes back to the same page', async () => {
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '?x=1', hash: '#view=apps', assign },
      dispatchEvent: vi.fn(),
    });
    const { reportServerAuthRejected } = await import('../api/server-auth');
    expect(reportServerAuthRejected(401, '/auth/login')).toBe(true);
    expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent('/?x=1#view=apps')}`);
    reportServerAuthRejected(401, '/auth/login');
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('never follows a sign-in link to another site', async () => {
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', assign }, dispatchEvent: vi.fn() });
    const { reportServerAuthRejected, wasServerAuthRejected } = await import('../api/server-auth');
    reportServerAuthRejected(401, '//evil.example/login');
    reportServerAuthRejected(401, 'https://evil.example/login');
    expect(assign).not.toHaveBeenCalled();
    expect(wasServerAuthRejected()).toBe(true);
  });
});

describe('a hosted page before (or without) its capability map', () => {
  afterEach(() => vi.unstubAllGlobals());
  const hostedPage = { querySelector: (selector: string) => (selector === 'meta[name="dql-hosted"]' ? { getAttribute: () => '1' } : null) };

  it('knows it is hosted from the page the server served; a page without the mark is single-user', () => {
    expect(pageSaysHosted(hostedPage as never)).toBe(true);
    expect(pageSaysHosted({ querySelector: () => null } as never)).toBe(false);
    expect(pageSaysHosted(undefined)).toBe(false);
  });

  it('shows no screens, only a neutral line, until the map is known', () => {
    vi.stubGlobal('document', hostedPage);
    const html = renderToStaticMarkup(<HostUiProvider><button type="button">Settings</button><button type="button">Source control</button></HostUiProvider>);
    expect(html).toContain('Connecting…');
    expect(html).not.toContain('Settings');
    expect(html).not.toContain('Source control');
  });

  it('a single-user page renders its screens at once, as before', () => {
    vi.stubGlobal('document', { querySelector: () => null });
    expect(renderToStaticMarkup(<HostUiProvider><span>Settings</span></HostUiProvider>)).toContain('Settings');
  });

  it('says plainly when ZLens cannot be reached after a while, and asks to sign in on a 401', () => {
    const since = 1_000_000;
    expect(renderToStaticMarkup(<HostConnecting pending={{ since, attempts: 2, status: 502 }} now={since + 2_000} />)).toContain('Connecting…');
    const late = renderToStaticMarkup(<HostConnecting pending={{ since, attempts: 4, status: 429 }} now={since + HOST_UNREACHABLE_AFTER_MS} />);
    expect(late).toContain('ZLens can&#x27;t be reached right now.');
    expect(late).toContain('Reload');
    expect(renderToStaticMarkup(<HostConnecting pending={{ since, attempts: 1, status: 401 }} now={since} />)).toContain('Sign in to use ZLens.');
  });

  it('reads the map defensively: only a hosted map with a person counts, and only `true` allows', () => {
    for (const junk of [null, 'x', { host: false }, { host: true }, { host: 'true', person: { id: 'u' } }]) expect(hostUiFrom(junk), JSON.stringify(junk)).toBeNull();
    const read = hostUiFrom({ host: true, person: { id: 'u-1', name: 'Ana' }, capabilities: { ask: true, export: 'yes', 'settings.manage': 1 }, links: { id: 'x' }, answerActions: [null, { id: 'a', label: 'A', url: '/a' }] });
    expect(read?.capabilities).toEqual({ ask: true, export: false, 'settings.manage': false });
    expect(read?.links).toEqual([]);
    expect(read?.answerActions).toEqual([{ id: 'a', label: 'A', url: '/a' }]);
  });

  it('keeps `certification: proposes` (the host certifies through its review) and drops any other value', () => {
    const map = { host: true, person: { id: 'u-1', name: 'Ana' }, capabilities: {} };
    const proposes = hostUiFrom({ ...map, certification: 'proposes' });
    expect(proposes?.certification).toBe('proposes');
    expect(hostProposesCertification(proposes!)).toBe(true);
    for (const junk of ['certifies', 'PROPOSES', true, 1, { kind: 'proposes' }, null]) {
      const read = hostUiFrom({ ...map, certification: junk });
      expect(read, JSON.stringify(junk)).not.toBeNull();
      expect(read, JSON.stringify(junk)).not.toHaveProperty('certification');
      expect(hostProposesCertification(read!), JSON.stringify(junk)).toBe(false);
    }
    expect(hostUiFrom(map)).not.toHaveProperty('certification');
    // Never without a host: `zlens notebook` certifies here.
    expect(hostProposesCertification(NO_HOST)).toBe(false);
    expect(hostProposesCertification(hosted())).toBe(false);
  });
});
