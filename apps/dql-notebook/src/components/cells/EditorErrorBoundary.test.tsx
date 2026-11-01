import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorErrorBoundary } from './EditorErrorBoundary';

function rendered(failed: boolean): string {
  const boundary = new EditorErrorBoundary({ text: '-- check\nSELECT 1', children: <span>the editor</span> });
  if (failed) boundary.state = EditorErrorBoundary.getDerivedStateFromError();
  return renderToStaticMarkup(<>{boundary.render()}</>);
}

describe('an editor that throws', () => {
  it('shows the editor while nothing is wrong', () => {
    expect(rendered(false)).toBe('<span>the editor</span>');
  });

  it('keeps the page: the person gets their text and a reload link', () => {
    const html = rendered(true);
    expect(html).toContain('role="alert"');
    expect(html).toContain('The editor stopped working.');
    expect(html).toContain('-- check\nSELECT 1');
    expect(html).toContain('reload the page</a>');
    expect(html).not.toContain('the editor</span>');
  });
});
