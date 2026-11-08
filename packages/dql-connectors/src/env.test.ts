import { describe, expect, it } from 'vitest';
import { bundledConnectorFolders, noEgress, readEnv } from './env.js';

describe('readEnv (copy of @zlens/core readEnv)', () => {
  it('prefers ZLENS_<X>, falls back to DQL_<X>, else undefined', () => {
    expect(readEnv('ZLENS_X', { ZLENS_X: 'new', DQL_X: 'old' })).toBe('new');
    expect(readEnv('ZLENS_X', { DQL_X: 'old' })).toBe('old');
    expect(readEnv('ZLENS_X', {})).toBeUndefined();
    expect(readEnv('ZLENS_X', { ZLENS_X: '', DQL_X: 'old' })).toBe('');
    expect(readEnv('DQL_X', { ZLENS_X: 'new' })).toBe('new');
    expect(readEnv('DO_NOT_TRACK', { DO_NOT_TRACK: '1' })).toBe('1');
  });
});

describe('an install with no internet access (ZLENS_NO_EGRESS)', () => {
  it('is on for 1, true, on or yes (either spelling), off otherwise', () => {
    for (const value of ['1', 'true', 'on', 'yes', 'TRUE']) expect(noEgress({ ZLENS_NO_EGRESS: value })).toBe(true);
    for (const value of [undefined, '', '0', 'off', 'no']) expect(noEgress({ ZLENS_NO_EGRESS: value })).toBe(false);
    expect(noEgress({ DQL_NO_EGRESS: '1' })).toBe(true);
  });

  it('reads the drivers that came with the install from ZLENS_CONNECTOR_PATH, separated like PATH', () => {
    expect(bundledConnectorFolders({ ZLENS_CONNECTOR_PATH: '/opt/zlens/drivers: /opt/extra ' }, ':')).toEqual(['/opt/zlens/drivers', '/opt/extra']);
    expect(bundledConnectorFolders({ ZLENS_CONNECTOR_PATH: 'C:\\drivers;D:\\more' }, ';')).toEqual(['C:\\drivers', 'D:\\more']);
    expect(bundledConnectorFolders({}, ':')).toEqual([]);
  });
});
