import React, { useEffect, useRef, useState } from 'react';
import { useOperations } from '../../operations/OperationsProvider';
import { useNotebookStore } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { taskCenterProjection, taskOutcomePresentation } from './task-center-presentation';

export function TaskCenter() {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const t = themes[themeMode];
  const { operations, loading, cancel } = useOperations();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    operations: visibleOperations,
    activeCount,
    attentionCount,
  } = taskCenterProjection(operations);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!loading && visibleOperations.length === 0) return null;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label="Background tasks"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          height: 28,
          padding: '0 9px',
          borderRadius: 6,
          border: `1px solid ${activeCount > 0 ? t.accent : attentionCount > 0 ? t.warning : t.btnBorder}`,
          background: open ? t.btnHover : t.btnBg,
          color: t.textSecondary,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: t.font,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: activeCount > 0 ? t.accent : attentionCount > 0 ? t.warning : t.success,
            boxShadow: activeCount > 0 ? `0 0 0 3px ${t.accent}20` : 'none',
          }}
        />
        {activeCount > 0 ? `${activeCount} running` : attentionCount > 0 ? `${attentionCount} needs attention` : 'Tasks'}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Background tasks"
          style={{
            position: 'absolute',
            top: 34,
            right: 0,
            zIndex: 1200,
            width: 340,
            maxHeight: 420,
            overflowY: 'auto',
            background: t.modalBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 9,
            boxShadow: '0 14px 36px rgba(0,0,0,0.28)',
            padding: 8,
          }}
        >
          <div style={{ padding: '4px 6px 8px', color: t.textPrimary, fontSize: 12, fontWeight: 700 }}>
            Background tasks
          </div>
          {visibleOperations.map((operation) => {
            const presentation = taskOutcomePresentation(operation);
            const active = presentation.active;
            const statusColor = presentation.tone === 'failure'
              ? t.error
              : presentation.tone === 'attention'
                ? t.warning
                : presentation.tone === 'success'
                  ? t.success
                  : t.textMuted;
            return (
              <div
                key={operation.id}
                style={{
                  padding: '9px 8px',
                  borderTop: `1px solid ${t.headerBorder}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, color: t.textPrimary, fontSize: 11.5, fontWeight: 650 }}>
                    {operationLabel(operation.type)}
                  </span>
                  <span style={{ color: statusColor, fontSize: 11 }}>
                    {presentation.statusLabel}
                  </span>
                </div>
                <div style={{ color: presentation.tone === 'failure' ? t.error : presentation.tone === 'attention' ? t.warning : t.textSecondary, fontSize: 11, lineHeight: 1.4 }}>
                  {presentation.message}
                </div>
                {active && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 3, borderRadius: 99, overflow: 'hidden', background: t.headerBorder }}>
                      <div style={{ width: `${Math.max(3, operation.progress)}%`, height: '100%', background: t.accent, transition: 'width 180ms ease' }} />
                    </div>
                    {operation.cancellable && (
                      <button
                        type="button"
                        onClick={() => void cancel(operation.id)}
                        style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', fontSize: 11, padding: 0 }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
                {operation.type === 'block_certification' && (
                  <div style={{ color: t.textMuted, fontSize: 11 }}>
                    {presentation.guidance
                      ?? (presentation.tone === 'success'
                        ? 'Certification is complete.'
                        : 'The saved draft is preserved for review or retry.')}
                  </div>
                )}
                {(operation.type === 'agent_run' || operation.type === 'app_ai_build') && (
                  <div style={{ color: t.textMuted, fontSize: 11 }}>
                    {active
                      ? 'This continues while you work on another page.'
                      : operation.status === 'succeeded'
                        ? 'Completed in the background.'
                        : 'Open the original surface to review or retry.'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function operationLabel(type: string): string {
  if (type === 'block_certification') return 'Saved query certification';
  if (type === 'project_refresh') return 'Project metadata refresh';
  if (type === 'agent_run') return 'AI request';
  if (type === 'app_ai_build') return 'App proposal';
  return type.replace(/_/g, ' ');
}
