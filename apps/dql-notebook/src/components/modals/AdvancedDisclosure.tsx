import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';

/**
 * Guided Setup keeps technical panels out of the way (design D7): they sit,
 * closed, under one **Advanced** disclosure. A native `<details>` so keyboard
 * and screen readers work as for any disclosure. Outside setup (`enabled`
 * false) the children render as they are.
 */
export function AdvancedDisclosure({
  enabled,
  label = 'Advanced',
  hint,
  t,
  children,
}: {
  enabled: boolean;
  label?: string;
  /** One line on what is inside, shown next to the label. */
  hint?: string;
  t: Theme;
  children: React.ReactNode;
}): JSX.Element {
  if (!enabled) return <>{children}</>;
  return (
    <details data-setup-advanced="" style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 10, background: t.cellBg, padding: '9px 12px', maxWidth: 640 }}>
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: t.textSecondary, fontFamily: t.font, listStyle: 'none' }}>
        <ChevronRight size={13} aria-hidden="true" className="dql-advanced-chevron" />
        {label}
        {hint ? <span style={{ fontWeight: 500, color: t.textMuted }}>· {hint}</span> : null}
      </summary>
      <style>{'details[data-setup-advanced] > summary::-webkit-details-marker { display: none; } details[data-setup-advanced][open] > summary .dql-advanced-chevron { transform: rotate(90deg); }'}</style>
      <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </details>
  );
}
