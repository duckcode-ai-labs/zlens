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
export function StudioErrorBanner({ error, floating = false, onDismiss, onRefresh }: { error: string; floating?: boolean; onDismiss?: () => void; onRefresh?: () => void }): JSX.Element {
  const words = studioErrorWords(error);
  return <div className={`studio-error ${floating ? 'floating' : ''}`} role="alert">
    <div className="studio-error-body">
      <span>{words.message}</span>
      {words.technical ? <details className="studio-error-technical"><summary>Technical details</summary><code>{words.technical}</code></details> : null}
    </div>
    {words.refresh && onRefresh ? <button type="button" className="studio-error-refresh" onClick={onRefresh}>Refresh</button> : null}
    {onDismiss ? <button type="button" aria-label="Dismiss" onClick={onDismiss}>×</button> : null}
  </div>;
}
