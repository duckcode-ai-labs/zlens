import { describe, expect, it } from 'vitest';
import { blockIdentityDialogCopy } from './BlockStudio';

describe('name-and-owner dialog in plain words (B10)', () => {
  it('says saving keeps a draft and never promises to certify', () => {
    const save = blockIdentityDialogCopy('save');
    expect(save.title).toBe('Name this saved query');
    expect(save.body).toContain('Saving keeps it as a draft');
    expect(save.body).not.toMatch(/governance|blockers|certify the block when/i);
  });

  it('says what Certify checks and that it records who and when', () => {
    expect(blockIdentityDialogCopy('certify').body).toContain('certifies it with your name and today');
  });
});
