import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskAboutApp } from './AskAboutApp';
import { AppAudienceEditor } from './AppAudienceEditor';
import { FollowPageButton } from './FollowPageButton';
import { HostUiProvider } from '../../host/host-ui';

/** RFC 0010 HH-16 in the App reader: ask about the App, follow a page, and the App's audience. */
describe('the App reader for stakeholders (HH-16)', () => {
  it('asks about the whole App, and shows what the question is scoped to', () => {
    const html = renderToStaticMarkup(
      <AskAboutApp
        scope={{ appId: 'claims-weekly', appName: 'Claims Weekly', domain: 'claims', dashboardId: 'overview', pageTitle: 'Claims this week', filters: [{ label: 'Region', value: 'West' }] }}
        onAsk={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Ask about Claims Weekly"');
    expect(html).toContain('placeholder="Ask about Claims Weekly…"');
    expect(html).toContain('Scoped to Claims Weekly · Claims this week');
    expect(html).toContain('Domain: claims');
    expect(html).toContain('Region: West');
    // An empty question cannot be sent.
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    // Before the page has run, the control says what Ask cannot see yet (N3).
    expect(html).toContain('Ask can see its saved queries and filters, not its results yet');
  });

  it('says it reads the page results, sources, trust and filters once the page has run (N3)', () => {
    const html = renderToStaticMarkup(
      <AskAboutApp
        scope={{ appId: 'claims-weekly', appName: 'Claims Weekly', dashboardId: 'overview', pageTitle: 'Claims this week', filters: [], resultsReady: true }}
        onAsk={() => undefined}
      />,
    );
    expect(html).toContain('Answers read this page’s current results, each tile’s source and trust label, and the filters on screen.');
    // Body text, so a text token that meets 4.5:1 on the panel in every theme; --text-muted is for icons and dividers (2.1:1).
    expect(html).toMatch(/class="dql-app-ask-capability"[^>]*color:var\(--text-tertiary\)/);
  });

  it('shows no Follow button until the server says whether this person follows the page', () => {
    expect(renderToStaticMarkup(<HostUiProvider initial={{ host: false }}><FollowPageButton appId="claims-weekly" pageId="overview" /></HostUiProvider>)).toBe('');
  });

  it('edits who the App is for, starting from what the file says', () => {
    const html = renderToStaticMarkup(<AppAudienceEditor appId="claims-weekly" audience="Claims leadership" groups={['claims-leaders']} />);
    expect(html).toContain('aria-label="Audience"');
    expect(html).toContain('value="Claims leadership"');
    // Groups load from the host (or become free text); saving waits for that.
    expect(html).toContain('Loading groups…');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save audience<\/button>/);
  });
});
