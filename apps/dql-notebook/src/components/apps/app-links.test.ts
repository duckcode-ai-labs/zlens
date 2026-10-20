import { describe, expect, it } from 'vitest';
import { appPageUrl, isLoopbackOrigin, readAppDraftLink, readAppPageLink, withAppPageLink, withoutAppDraftLink } from './app-links';

describe('App page links (RFC 0008 step 10)', () => {
  it('reads and writes the page link, keeping other location state', () => {
    expect(readAppPageLink('http://127.0.0.1:3474/?app=commerce-pilot&page=overview')).toEqual({ appId: 'commerce-pilot', pageId: 'overview' });
    expect(readAppPageLink('http://127.0.0.1:3474/?app=a%20b')).toEqual({ appId: 'a b', pageId: null });
    expect(readAppPageLink('http://127.0.0.1:3474/?page=overview')).toBeNull();
    expect(readAppPageLink('not a url')).toBeNull();
    expect(withAppPageLink('http://h/?theme=x#dql_token=t', { appId: 'sales', pageId: 'q3 review' })).toBe('/?theme=x&app=sales&page=q3+review#dql_token=t');
    expect(withAppPageLink('http://h/?app=sales&page=p&theme=x', null)).toBe('/?theme=x');
  });

  it('builds full links, with the access token only in the fragment', () => {
    expect(appPageUrl('http://127.0.0.1:3474/', { appId: 'sales', pageId: 'overview' })).toBe('http://127.0.0.1:3474/?app=sales&page=overview');
    expect(appPageUrl('http://192.168.1.20:3474', { appId: 'sales', pageId: null }, 'tok en')).toBe('http://192.168.1.20:3474/?app=sales#dql_token=tok%20en');
    expect(isLoopbackOrigin('http://127.0.0.1:3474')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:3474')).toBe(true);
    expect(isLoopbackOrigin('http://192.168.1.20:3474')).toBe(false);
  });
});

describe('App Studio draft links (design D9: MCP build_dql_app)', () => {
  it('reads the draft link and removes it without touching other location state', () => {
    expect(readAppDraftLink('http://127.0.0.1:3474/?appDraft=build_1760000000000_ab12cd')).toBe('build_1760000000000_ab12cd');
    expect(readAppDraftLink('http://127.0.0.1:3474/?appDraft=..%2Fetc')).toBeNull();
    expect(readAppDraftLink('http://127.0.0.1:3474/?app=sales')).toBeNull();
    expect(readAppDraftLink('not a url')).toBeNull();
    expect(withoutAppDraftLink('http://h/?appDraft=build_1&theme=x#dql_token=t')).toBe('/?theme=x#dql_token=t');
  });
});
