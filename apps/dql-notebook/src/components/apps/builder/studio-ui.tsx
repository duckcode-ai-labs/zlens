import type { ReactNode } from 'react';
import { relatedFieldWords } from '@zlens/core/datasets/related-fields';
import { studioErrorWords } from '../app-studio-words';

/** A name in words: "order_total" → "Order Total"; a related field "location__location_name" → "Location Name" (design D2). */
export function humanize(value: string): string {
  return (relatedFieldWords(value) ?? value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function PanelTitle({ title, detail, action }: { title: string; detail: string; action?: ReactNode }): JSX.Element {
  return <header className="panel-title"><div><strong>{title}</strong><small>{detail}</small></div>{action}</header>;
}

/**
 * An error in plain words (F11): a known code becomes a sentence, with
 * Refresh when the App changed in another tab; the server's own words stay
 * under Technical details.
 */
export function StudioErrorBanner({ error, floating = false, onDismiss, onRefresh, lead, action, actions, technical }: {
  error: string;
  floating?: boolean;
  onDismiss?: () => void;
  onRefresh?: () => void;
  /** A sentence said before the error, e.g. what did not happen because of it. */
  lead?: string;
  /** One more way out, e.g. Try again. */
  action?: { label: string; onClick: () => void };
  /** More ways out, in order (e.g. Refresh this data, Choose it again). */
  actions?: Array<{ label: string; onClick: () => void }>;
  /** `error` is already plain words; this is the reason, shown only under Technical details. */
  technical?: string;
}): JSX.Element {
  const words = technical !== undefined ? { message: error, technical, refresh: false } : studioErrorWords(error);
  const buttons = [...(action ? [action] : []), ...(actions ?? [])];
  return <div className={`studio-error ${floating ? 'floating' : ''}`} role="alert">
    <div className="studio-error-body">
      <span>{lead ? `${lead} ${words.message}` : words.message}</span>
      {words.technical ? <details className="studio-error-technical"><summary>Technical details</summary><code>{words.technical}</code></details> : null}
    </div>
    {buttons.map((button) => <button key={button.label} type="button" className="studio-error-refresh" onClick={button.onClick}>{button.label}</button>)}
    {words.refresh && onRefresh ? <button type="button" className="studio-error-refresh" onClick={onRefresh}>Refresh</button> : null}
    {onDismiss ? <button type="button" aria-label="Dismiss" onClick={onDismiss}>×</button> : null}
  </div>;
}
