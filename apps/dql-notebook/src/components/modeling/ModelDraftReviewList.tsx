import React from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import type { ContextAuthoringPatchV1 } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';
import type { DraftCheck, DraftReview } from './model-draft-review';

/** A drafted model, by group, with each change's check (RFC 0012, P5). */
export function ModelDraftReviewList({
  review,
  selected,
  busy,
  patchesByOperation,
  onToggle,
  theme,
}: {
  review: DraftReview;
  selected: readonly string[];
  busy: boolean;
  patchesByOperation: Map<string, ContextAuthoringPatchV1[]>;
  onToggle: (operationId: string, checked: boolean) => void;
  theme: Theme;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 14 }}>
      {review.groups.map((group) => (
        <section key={group.key} aria-label={group.title}>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 12.5 }}>{group.title}</strong>
            <span style={{ fontSize: 10.5, color: theme.textMuted }}>{group.items.length}</span>
          </header>
          {group.hint ? <p style={{ margin: '0 0 8px', fontSize: 10.5, color: theme.textMuted, lineHeight: 1.45 }}>{group.hint}</p> : null}
          <div role="list" style={{ display: 'grid', gap: 6 }}>
            {group.items.map((item) => {
              const patches = (patchesByOperation.get(item.operationId) ?? []).filter((patch) => patch.changed);
              return (
                <div key={item.operationId} role="listitem" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: theme.cellBg }}>
                  <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px', cursor: busy ? 'wait' : 'pointer' }}>
                    <input type="checkbox" checked={selected.includes(item.operationId)} disabled={busy} onChange={(event) => onToggle(item.operationId, event.target.checked)} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <b style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>{item.title}</b>
                        {group.key === 'joins' ? <CheckBadge check={item.check} theme={theme} /> : null}
                      </span>
                      {item.detail ? <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: theme.textSecondary, lineHeight: 1.45 }}>{item.detail}</span> : null}
                      {item.reason ? <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: item.check === 'passed' ? theme.textMuted : 'var(--status-warning, #b7791f)', lineHeight: 1.45 }}>{item.reason}</span> : null}
                    </span>
                  </label>
                  {item.query ? (
                    <details style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <summary style={{ padding: '6px 11px', cursor: 'pointer', color: theme.textSecondary, fontSize: 10 }}>The query that measured it</summary>
                      <pre style={{ margin: 0, padding: '6px 11px 9px', fontSize: 9.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: theme.textSecondary }}>{item.query}</pre>
                    </details>
                  ) : null}
                  {patches.map((patch) => (
                    <details key={`${patch.operationId}-${patch.path}`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <summary style={{ padding: '6px 11px', cursor: 'pointer', color: theme.textSecondary, fontSize: 10 }}>File change · <code>{patch.path}</code></summary>
                      <pre style={{ margin: 0, padding: '6px 11px 9px', fontSize: 9.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', color: theme.textSecondary }}>{patch.after || '∅'}</pre>
                    </details>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function CheckBadge({ check, theme }: { check: DraftCheck; theme: Theme }): JSX.Element {
  const look = check === 'passed'
    ? { icon: <CheckCircle2 size={11} />, label: 'Passed', color: 'var(--status-success, #2f855a)' }
    : check === 'failed'
      ? { icon: <AlertTriangle size={11} />, label: 'Needs a look', color: 'var(--status-warning, #b7791f)' }
      : { icon: <CircleDashed size={11} />, label: 'Not checked', color: theme.textMuted };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 600, color: look.color, whiteSpace: 'nowrap' }}>
      {look.icon}{look.label}
    </span>
  );
}
