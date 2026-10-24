import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const TOKENS = readFileSync(join(REPO, 'packages/dql-ui/src/styles/tokens.css'), 'utf8');

function themeBlock(selector: string): string {
  const start = TOKENS.indexOf(selector);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  return TOKENS.slice(start, TOKENS.indexOf('\n}', start));
}

function token(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  expect(match, `--${name}`).not.toBeNull();
  return match![1].trim().toLowerCase();
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('ZLens brand tokens', () => {
  const themes = {
    obsidian: themeBlock(':root {'),
    paper: themeBlock('[data-theme="paper"] {'),
    white: themeBlock('[data-theme="white"] {'),
  };

  it('uses deep teal as the one accent in every theme', () => {
    expect(token(themes.paper, 'accent')).toBe('#0b7a75');
    expect(token(themes.white, 'accent')).toBe('#0b7a75');
    expect(token(themes.obsidian, 'accent')).toBe('#2bb3a9');
    for (const block of Object.values(themes)) {
      expect(token(block, 'border-focus')).toBe(token(block, 'accent'));
    }
  });

  it('keeps accent buttons and caption text readable', () => {
    // White text on the light accent, dark text on the dark accent.
    expect(contrast(token(themes.paper, 'accent'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(themes.obsidian, 'accent'), token(themes.obsidian, 'accent-fg'))).toBeGreaterThanOrEqual(4.5);
    // Caption (tertiary) text on paper cards.
    expect(contrast(token(themes.paper, 'text-tertiary'), token(themes.paper, 'bg-2'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps secondary and tertiary text at WCAG AA (4.5:1) on every page surface, in every theme', () => {
    // Obsidian is the :root default; paper and white define their own surfaces.
    const surfaces = ['bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-canvas'];
    const low: string[] = [];
    for (const [name, block] of Object.entries(themes)) {
      for (const text of ['text-secondary', 'text-tertiary']) {
        for (const surface of surfaces) {
          const ratio = contrast(token(block, text), token(block, surface));
          if (ratio < 4.5) low.push(`${name} --${text} on --${surface}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(low).toEqual([]);
  });

  it('has no gradient brand mark and no leftover purple accent anywhere in the UI source', () => {
    expect(TOKENS).not.toMatch(/\.brand-mark\s*\{[^}]*gradient/);
    const offenders = [
      ...sourceFiles(join(REPO, 'apps/dql-notebook/src')),
      ...sourceFiles(join(REPO, 'packages/dql-ui/src')),
    ].filter((file) => /#6b5dd3|#5c4fc2|#f3f0fb|linear-gradient\(135deg, #5b8cff/i.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => file.slice(REPO.length))).toEqual([]);
  });

  it('lines digits up across the whole app', () => {
    expect(TOKENS).toMatch(/body \{[^}]*font-variant-numeric: tabular-nums;/);
  });
});
