import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import type { AskReadiness } from '../../api/client';
import { AskReadinessStrip, askReadinessStrip, checkedAtLabel } from './AskReadinessStrip';

vi.mock('../../api/client', () => ({ api: {} }));

const missingGrant: AskReadiness = {
  state: 'missing_grant',
  headline: 'Ask is not ready: ZLens may not use Snowflake Cortex yet.',
  message: 'The Snowflake role ZLens signs in with cannot use Cortex. Ask your Snowflake admin to grant it the SNOWFLAKE.CORTEX_USER database role (for the ZLens app: GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP) (HTTP 403).',
  fixSql: 'GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;',
  fixIntro: 'An ACCOUNTADMIN runs this one line in Snowsight:',
  model: 'claude-sonnet-5-5',
  route: 'sql',
  checkedAt: '2026-11-25T18:00:00.000Z',
};

describe('the Ask is not ready strip', () => {
  it('shows nothing while Ask is ready, while the first check runs, or without Cortex', () => {
    expect(askReadinessStrip(null)).toBeNull();
    expect(askReadinessStrip({ state: 'not_applicable' })).toBeNull();
    expect(askReadinessStrip({ state: 'checking', headline: 'Checking…' })).toBeNull();
    expect(askReadinessStrip({ state: 'ready', headline: 'Ask is ready: it uses claude-sonnet-5-5 through Cortex SQL (AI_COMPLETE).', route: 'sql', checkedAt: '2026-11-25T18:00:00.000Z' })).toBeNull();
    expect(renderToStaticMarkup(<AskReadinessStrip t={themes.paper} initial={{ state: 'not_applicable' }} />)).toBe('');
  });

  it('says what is wrong and gives the exact line with the app\'s name, a copy button and Check again', () => {
    const html = renderToStaticMarkup(<AskReadinessStrip t={themes.paper} initial={missingGrant} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Ask is not ready: ZLens may not use Snowflake Cortex yet.');
    expect(html).toContain('An ACCOUNTADMIN runs this one line in Snowsight:');
    expect(html).toContain('GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP;');
    expect(html).toContain('Check again');
    expect(html).toContain('Copy the line');
  });

  it('has no line to copy when the fix is in Settings (a model Cortex does not offer)', () => {
    const html = renderToStaticMarkup(<AskReadinessStrip t={themes.paper} initial={{ state: 'model_unavailable', headline: 'Ask is not ready: Snowflake Cortex does not offer claude-opus-4-1 in your account.', message: 'Pick another Claude model in Settings » AI.', checkedAt: '2026-11-25T18:00:00.000Z' }} />);
    expect(html).toContain('Pick another Claude model in Settings » AI.');
    expect(html).not.toContain('Copy the line');
    expect(html).not.toContain('data-testid="ask-readiness-fix"');
  });

  it('tells the time of the check, and nothing for a time it cannot read', () => {
    expect(checkedAtLabel('2026-11-25T18:00:00.000Z')).toMatch(/^Checked at .+\.$/);
    expect(checkedAtLabel('not a time')).toBe('');
  });
});
