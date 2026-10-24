import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PAGE_FORMATS, PageFormatPicker, pageFormatLabel } from './PageFormatPicker';

describe('page format picker', () => {
  it('names the page style in plain words, not a tab to flip', () => {
    const markup = renderToStaticMarkup(<PageFormatPicker value="story" disabled={false} onChange={() => undefined} />);
    expect(markup).toContain('Page style:');
    expect(markup).not.toContain('Readers see this page as');
    expect(markup).toContain('<strong>Report</strong>');
    expect(markup).toContain('aria-haspopup="true"');
    expect(markup).not.toContain('Story');
  });

  it('names every format with what it shows', () => {
    expect(PAGE_FORMATS.map((format) => format.label)).toEqual(['Dashboard', 'Report', 'Custom layout']);
    expect(PAGE_FORMATS.every((format) => format.description.length > 10)).toBe(true);
    expect(pageFormatLabel('canvas')).toBe('Custom layout');
  });
});
