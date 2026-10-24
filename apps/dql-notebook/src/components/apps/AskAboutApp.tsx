import { useState, type FormEvent } from 'react';
import { MessageSquare, SendHorizontal } from 'lucide-react';

/**
 * "Ask about this App" (RFC 0010, HH-16): one question box for the whole App
 * in the reader, beside the questions on each chart. It is asked through the
 * governed Ask loop with the App's scope — its domain and the filters on
 * screen (the server reads both from the App's own files; see
 * app-copilot-scope) — and the page run on screen, so a question about what
 * the App shows is answered from that run's results (app-view-answer). The
 * answer carries the trust label of the tiles it read and is never wider than
 * the view it was asked from.
 */
/**
 * "Scoped to <App> · <page>", naming the page only when its title is not the
 * App's own name (a one-page App titles its page after the App).
 */
export function askAboutAppScopeLine(appName: string, pageTitle?: string): string {
  const page = pageTitle?.trim();
  const samePage = !page || page.toLowerCase() === appName.trim().toLowerCase();
  return `Scoped to ${appName}${samePage ? '' : ` · ${page}`}`;
}

export interface AskAboutAppScope {
  appId: string;
  appName: string;
  domain?: string;
  dashboardId?: string;
  pageTitle?: string;
  /** The filters with a value on screen, as the reader sees them. */
  filters: Array<{ label: string; value: string }>;
  /**
   * Whether the page has a current run Ask can read. The question names that
   * run; the server reads its tiles, sources, trust labels and shown rows
   * from its own evidence of it. Without one, Ask sees the App's blocks and
   * filters but not its results, and the control says so before asking.
   */
  resultsReady?: boolean;
}

/** What Ask will see of this App, stated before the question is sent. */
export function askAboutAppCapability(scope: Pick<AskAboutAppScope, 'resultsReady'>): string {
  return scope.resultsReady
    ? 'Answers read this page’s current results, each tile’s source and trust label, and the filters on screen.'
    : 'This page has not finished running: Ask can see its saved queries and filters, not its results yet.';
}

/** What the Ask box says when no AI provider is connected: no question box, no "AI-generated" label (round 3). */
export const ASK_NEEDS_AI_PROVIDER = 'Ask needs an AI provider. The owner can connect one in Settings.';

export function AskAboutApp({ scope, onAsk, aiConnected }: {
  scope: AskAboutAppScope;
  onAsk: (question: string) => void;
  /** `false` when no AI provider is connected: the box says so instead of taking a question. */
  aiConnected?: boolean;
}): JSX.Element {
  const [question, setQuestion] = useState('');
  if (aiConnected === false) {
    return (
      <div
        className="dql-app-ask-about dql-app-ask-unavailable"
        role="note"
        aria-label={`Ask about ${scope.appName}`}
        style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px', padding: '8px 12px', border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-2)', fontSize: 12.5, color: 'var(--text-secondary)' }}
      >
        <MessageSquare size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span>{ASK_NEEDS_AI_PROVIDER}</span>
      </div>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    onAsk(text);
    setQuestion('');
  };
  const chips = [scope.domain ? `Domain: ${scope.domain}` : null, ...scope.filters.map((filter) => `${filter.label}: ${filter.value}`)].filter((chip): chip is string => !!chip);
  return (
    <form
      className="dql-app-ask-about"
      aria-label={`Ask about ${scope.appName}`}
      onSubmit={submit}
      style={{ display: 'grid', gap: 6, margin: '4px 0 12px', padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-2)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <MessageSquare size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={`Ask about ${scope.appName}…`}
          aria-label={`Ask a question about ${scope.appName}`}
          maxLength={600}
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 13.5 }}
        />
        <button type="submit" className="dql-apps-btn dql-apps-btn-primary" disabled={!question.trim()} title="Ask with this App's scope">
          <SendHorizontal size={13} /> Ask
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)' }} aria-label="What the question is scoped to">
        <span>{askAboutAppScopeLine(scope.appName, scope.pageTitle)}</span>
        {chips.map((chip) => (
          <span key={chip} style={{ padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border-subtle)', background: 'var(--bg-1)' }}>{chip}</span>
        ))}
      </div>
      <div className="dql-app-ask-capability" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{askAboutAppCapability(scope)}</div>
    </form>
  );
}
