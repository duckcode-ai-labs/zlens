import type { ReactNode } from 'react';
import { relatedFieldWords } from '@zlens/core/datasets/related-fields';

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
