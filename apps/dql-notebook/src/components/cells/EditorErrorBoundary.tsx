import React from 'react';

interface EditorErrorBoundaryProps {
  /** The text in the editor: what the person would otherwise lose. */
  text: string;
  children: React.ReactNode;
}

/**
 * An exception in an editor stops at the editor. Without this React unmounts
 * the whole app to a blank page and the unsaved text goes with it; here the
 * person keeps the page and can copy their text before reloading.
 */
export class EditorErrorBoundary extends React.Component<EditorErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[zlens] the editor stopped working', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" data-testid="editor-failed" style={{ display: 'grid', gap: 8, height: '100%', minHeight: 80, boxSizing: 'border-box', padding: 12, gridTemplateRows: 'auto 1fr', background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)', fontSize: 13 }}>
        <span>
          The editor stopped working. Your text is below; copy it, then{' '}
          <a href="" onClick={(event) => { event.preventDefault(); window.location.reload(); }} style={{ color: 'var(--color-accent-blue)' }}>reload the page</a>.
        </span>
        <textarea
          readOnly
          aria-label="Your text"
          value={this.props.text}
          style={{ width: '100%', minHeight: 80, boxSizing: 'border-box', resize: 'none', padding: 8, border: '1px solid var(--color-border-subtle)', borderRadius: 6, background: 'transparent', color: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 13 }}
        />
      </div>
    );
  }
}
