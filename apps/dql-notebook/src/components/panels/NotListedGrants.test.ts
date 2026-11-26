import { describe, expect, it } from 'vitest';
import { notListedGrantLines } from './NotListedGrants';

describe('a database or schema not listed (onboarding design P6)', () => {
  it('gives the admin the grants with the app\'s name filled in', () => {
    expect(notListedGrantLines('ZLENS_APP').split('\n')).toEqual([
      'GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;',
      'GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;',
      'GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;',
    ]);
    expect(notListedGrantLines('')).toContain('TO APPLICATION <this app>;');
  });
});
